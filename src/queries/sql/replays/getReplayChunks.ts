import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_CHUNKS,
  MAX_REPLAY_EVENTS,
  MAX_REPLAY_STORED_BYTES,
  ReplayBudgetExceededError,
} from '@/lib/replay-budget';
import {
  countReplayStructureUnits,
  hasBoundedReplayJsonStructure,
  MAX_REPLAY_STRUCTURE_UNITS,
} from '@/lib/replay-structure';

const FUNCTION_NAME = 'getReplayChunks';
const gunzipAsync = promisify(gunzip);

export interface ReplayChunk {
  sessionId: string;
  visitId: string;
  events: any[];
  chunkIndex: number;
  eventCount: number;
  startedAt: Date;
  endedAt: Date;
}

interface GetReplayChunksOptions {
  endAt?: Date;
  endChunkIndex?: number;
}

export async function getReplayChunks(
  websiteId: string,
  visitId: string,
  options: GetReplayChunksOptions = {},
): Promise<ReplayChunk[]> {
  return runQuery({
    [PRISMA]: () => relationalQuery(websiteId, visitId, options),
    [CLICKHOUSE]: () => clickhouseQuery(websiteId, visitId, options),
  });
}

async function relationalQuery(
  websiteId: string,
  visitId: string,
  { endAt, endChunkIndex }: GetReplayChunksOptions,
): Promise<ReplayChunk[]> {
  const { rawQuery } = prisma;
  const endAtFilter = endAt
    ? `
      and started_at <= {{endAt}}
    `
    : '';
  const endChunkFilter =
    endChunkIndex !== undefined
      ? `
      and chunk_index <= {{endChunkIndex}}
    `
      : '';

  const chunks: {
    sessionId: string;
    visitId: string;
    events: Buffer | null;
    chunkIndex: number;
    eventCount: number;
    startedAt: Date;
    endedAt: Date;
    totalChunks: bigint;
    storedBytes: bigint;
  }[] = await rawQuery(
    `
    with selected as materialized (
      select replay_id, chunk_index, octet_length(events) as stored_bytes
      from session_replay
      where website_id = {{websiteId::uuid}}
        and visit_id = {{visitId::uuid}}
        ${endAtFilter}
        ${endChunkFilter}
      order by chunk_index asc
      limit ${MAX_REPLAY_CHUNKS + 1}
    ), budget as (
      select count(*) as total_chunks,
        coalesce(sum(stored_bytes), 0) as stored_bytes
      from selected
    )
    select
      replay.session_id as "sessionId",
      replay.visit_id as "visitId",
      case when budget.total_chunks <= ${MAX_REPLAY_CHUNKS}
        and budget.stored_bytes <= ${MAX_REPLAY_STORED_BYTES}
        then replay.events else null end as events,
      selected.chunk_index as "chunkIndex",
      replay.event_count as "eventCount",
      replay.started_at as "startedAt",
      replay.ended_at as "endedAt",
      budget.total_chunks as "totalChunks",
      budget.stored_bytes as "storedBytes"
    from selected
      join session_replay replay on replay.replay_id = selected.replay_id
      cross join budget
    order by selected.chunk_index asc
    `,
    { websiteId, visitId, endAt, endChunkIndex },
    FUNCTION_NAME,
  );

  if (
    chunks.length > MAX_REPLAY_CHUNKS ||
    chunks.some(
      chunk =>
        chunk.events === null ||
        Number(chunk.totalChunks) > MAX_REPLAY_CHUNKS ||
        Number(chunk.storedBytes) > MAX_REPLAY_STORED_BYTES,
    )
  ) {
    throw new ReplayBudgetExceededError();
  }

  let decodedBytes = 0;
  let eventCount = 0;
  let remainingStructureUnits = MAX_REPLAY_STRUCTURE_UNITS;
  const decoded: ReplayChunk[] = [];

  for (const { totalChunks, storedBytes, ...chunk } of chunks) {
    let rawEvents: Buffer;

    if (decodedBytes >= MAX_REPLAY_BYTES) {
      throw new ReplayBudgetExceededError();
    }

    try {
      rawEvents = await gunzipAsync(Buffer.from(chunk.events), {
        maxOutputLength: MAX_REPLAY_BYTES - decodedBytes,
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ReplayBudgetExceededError();
      }

      throw error;
    }

    decodedBytes += rawEvents.byteLength;
    const serialized = rawEvents.toString('utf-8');

    if (!hasBoundedReplayJsonStructure(serialized, 257)) {
      throw new ReplayBudgetExceededError();
    }

    const events = JSON.parse(serialized);
    const structureUnits = countReplayStructureUnits(events, remainingStructureUnits, 257);

    if (
      !Array.isArray(events) ||
      structureUnits === null ||
      eventCount + events.length > MAX_REPLAY_EVENTS
    ) {
      throw new ReplayBudgetExceededError();
    }

    remainingStructureUnits -= structureUnits;
    eventCount += events.length;
    decoded.push({ ...chunk, events });
  }

  return decoded;
}

async function clickhouseQuery(
  websiteId: string,
  visitId: string,
  { endAt, endChunkIndex }: GetReplayChunksOptions,
): Promise<ReplayChunk[]> {
  const { rawQuery } = clickhouse;
  const endAtFilter = endAt
    ? `
      and started_at <= {endAt:DateTime64}
    `
    : '';
  const endChunkFilter =
    endChunkIndex !== undefined
      ? `
      and chunk_index <= {endChunkIndex:UInt32}
    `
      : '';

  const results = await rawQuery<
    {
      sessionId: string;
      visitId: string;
      events: string;
      chunk_index: number;
      event_count: number;
      started_at: string;
      ended_at: string;
      totalChunks: number;
      storedBytes: number;
    }[]
  >(
    `
    select sessionId, visitId,
      if(totalChunks <= ${MAX_REPLAY_CHUNKS} and storedBytes <= ${MAX_REPLAY_BYTES}, events, '') as events,
      chunk_index, event_count, started_at, ended_at, totalChunks, storedBytes
    from (
      select *, count() over () as totalChunks,
        sum(length(events)) over () as storedBytes
      from (
        select session_id as sessionId, visit_id as visitId, events, chunk_index,
          event_count, started_at, ended_at
        from session_replay
        prewhere website_id = {websiteId:UUID}
          and visit_id = {visitId:UUID}
          ${endAtFilter}
          ${endChunkFilter}
        order by chunk_index asc
        limit ${MAX_REPLAY_CHUNKS + 1}
      )
    )
    order by chunk_index asc
    `,
    { websiteId, visitId, endAt, endChunkIndex },
    FUNCTION_NAME,
  );

  if (
    results.length > MAX_REPLAY_CHUNKS ||
    results.some(
      row =>
        !row.events ||
        Number(row.totalChunks) > MAX_REPLAY_CHUNKS ||
        Number(row.storedBytes) > MAX_REPLAY_BYTES,
    )
  ) {
    throw new ReplayBudgetExceededError();
  }

  let decodedBytes = 0;
  let eventCount = 0;
  let remainingStructureUnits = MAX_REPLAY_STRUCTURE_UNITS;

  return results.map(row => {
    decodedBytes += Buffer.byteLength(row.events, 'utf-8');

    if (decodedBytes > MAX_REPLAY_BYTES) {
      throw new ReplayBudgetExceededError();
    }

    if (!hasBoundedReplayJsonStructure(row.events, 257)) {
      throw new ReplayBudgetExceededError();
    }

    const events = JSON.parse(row.events);
    const structureUnits = countReplayStructureUnits(events, remainingStructureUnits, 257);

    if (
      !Array.isArray(events) ||
      structureUnits === null ||
      eventCount + events.length > MAX_REPLAY_EVENTS
    ) {
      throw new ReplayBudgetExceededError();
    }

    remainingStructureUnits -= structureUnits;
    eventCount += events.length;

    return {
      sessionId: row.sessionId,
      visitId: row.visitId,
      events,
      chunkIndex: row.chunk_index,
      eventCount: row.event_count,
      startedAt: new Date(row.started_at),
      endedAt: new Date(row.ended_at),
    };
  });
}
