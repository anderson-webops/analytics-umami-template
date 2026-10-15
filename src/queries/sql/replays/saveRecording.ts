import { gzipSync } from 'node:zlib';
import type { Prisma } from '@/generated/prisma/client';
import clickhouse from '@/lib/clickhouse';
import { uuid } from '@/lib/crypto';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import kafka, { getMaxMessageBytes } from '@/lib/kafka';
import prisma from '@/lib/prisma';
import { REPLAY_EVENT_FRAGMENT_TYPE } from '@/lib/replay';
import { MAX_REPLAY_BYTES, ReplayBudgetExceededError } from '@/lib/replay-budget';
import {
  MAX_FRAGMENT_PARTS,
  MAX_FRAGMENT_VALUE_BYTES,
  type ReplayFragmentPart,
} from '@/lib/replay-fragment-buffer';
import { sanitizeReplayResourceEvents } from '@/lib/replay-resources.server';
import { redactReplayNavigationEvents } from '@/recorder/url';

export interface SaveRecordingArgs {
  websiteId: string;
  sessionId: string;
  visitId: string;
  chunkIndex: number;
  events: any[];
  eventCount: number;
  startedAt: Date;
  endedAt: Date;
}

export interface SaveReassembledRecordingArgs {
  websiteId: string;
  sessionId: string;
  visitId: string;
  event: unknown;
  parts: ReplayFragmentPart[];
  startedAt: Date;
  endedAt: Date;
}

const MAX_FRAGMENT_TRANSPORT_BYTES = 800_000;

function getTransportSize(fragment: unknown): number {
  return Buffer.byteLength(JSON.stringify({ events: JSON.stringify([fragment]) }), 'utf8') + 1024;
}

function getSafeFragmentRows(args: SaveReassembledRecordingArgs): SaveRecordingArgs[] {
  const { event, parts, websiteId, sessionId, visitId, startedAt, endedAt } = args;
  const orderedParts = [...parts].sort((left, right) => left.index - right.index);

  if (
    orderedParts.length === 0 ||
    orderedParts.length > MAX_FRAGMENT_PARTS ||
    orderedParts.some(
      (part, index) =>
        part.index !== index ||
        part.total !== orderedParts.length ||
        part.id !== orderedParts[0].id ||
        part.chunkIndex !== orderedParts[0].chunkIndex + index,
    )
  ) {
    throw new ReplayBudgetExceededError();
  }

  const safeEvents = sanitizeReplayResourceEvents(redactReplayNavigationEvents([event]));

  if (safeEvents.length !== 1) {
    throw new ReplayBudgetExceededError();
  }

  const serialized = JSON.stringify(safeEvents[0]);

  if (Buffer.byteLength(serialized, 'utf8') > MAX_REPLAY_BYTES) {
    throw new ReplayBudgetExceededError();
  }

  let offset = 0;
  const transportLimit = kafka.enabled
    ? Math.min(MAX_FRAGMENT_TRANSPORT_BYTES, getMaxMessageBytes())
    : MAX_FRAGMENT_TRANSPORT_BYTES;
  const rows = orderedParts.map(part => {
    let low = offset;
    let high = Math.min(serialized.length, offset + MAX_FRAGMENT_VALUE_BYTES);
    let end = offset;

    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const fragment = {
        type: 'umami:rrweb-event-fragment',
        timestamp: part.timestamp,
        data: {
          id: part.id,
          index: part.index,
          total: part.total,
          value: serialized.slice(offset, midpoint),
        },
      };

      if (getTransportSize(fragment) <= transportLimit) {
        end = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }

    if (end === offset && offset < serialized.length) {
      throw new ReplayBudgetExceededError();
    }

    const fragment = {
      type: 'umami:rrweb-event-fragment',
      timestamp: part.timestamp,
      data: {
        id: part.id,
        index: part.index,
        total: part.total,
        value: serialized.slice(offset, end),
      },
    };
    offset = end;

    return {
      websiteId,
      sessionId,
      visitId,
      chunkIndex: part.chunkIndex,
      events: [fragment],
      eventCount: part.index === 0 ? 1 : 0,
      startedAt,
      endedAt,
    };
  });

  if (offset !== serialized.length) {
    throw new ReplayBudgetExceededError();
  }

  return rows;
}

export async function saveReassembledRecordingFragments(
  args: SaveReassembledRecordingArgs,
  transaction?: Prisma.TransactionClient,
) {
  const rows = getSafeFragmentRows(args);

  if (transaction) {
    return Promise.all(rows.map(row => relationalQuery(row, transaction)));
  }

  return runQuery({
    [PRISMA]: () => Promise.all(rows.map(row => relationalQuery(row))),
    [CLICKHOUSE]: () => Promise.all(rows.map(row => clickhouseQuery(row))),
  });
}

export async function saveRecording(
  args: SaveRecordingArgs,
  transaction?: Prisma.TransactionClient,
) {
  if (args.events.some(event => event?.type === REPLAY_EVENT_FRAGMENT_TYPE)) {
    throw new Error('Raw replay fragments require pre-persistence reconstruction.');
  }

  const safeEvents = sanitizeReplayResourceEvents(redactReplayNavigationEvents(args.events));
  const safeArgs = {
    ...args,
    events: safeEvents,
    eventCount: safeEvents.length,
  };

  if (transaction) {
    return relationalQuery(safeArgs, transaction);
  }

  return runQuery({
    [PRISMA]: () => relationalQuery(safeArgs),
    [CLICKHOUSE]: () => clickhouseQuery(safeArgs),
  });
}

async function relationalQuery(
  {
    websiteId,
    sessionId,
    visitId,
    chunkIndex,
    events,
    eventCount,
    startedAt,
    endedAt,
  }: SaveRecordingArgs,
  transaction: Prisma.TransactionClient | typeof prisma.client = prisma.client,
) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(events), 'utf-8'));

  return transaction.sessionReplay.create({
    data: {
      id: uuid(),
      websiteId,
      sessionId,
      visitId,
      chunkIndex,
      events: compressed as any,
      eventCount,
      startedAt,
      endedAt,
    },
  });
}

async function clickhouseQuery({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
  eventCount,
  startedAt,
  endedAt,
}: SaveRecordingArgs) {
  const { insert, getUTCString } = clickhouse;
  const { sendMessage } = kafka;
  const acceptedAt = getUTCString(new Date());

  const message = {
    replay_id: uuid(),
    website_id: websiteId,
    session_id: sessionId,
    visit_id: visitId,
    chunk_index: chunkIndex,
    events: JSON.stringify(events),
    event_count: eventCount,
    started_at: getUTCString(startedAt),
    ended_at: getUTCString(endedAt),
    retention_policy: 1,
    ingested_at: acceptedAt,
  };

  if (kafka.enabled) {
    return sendMessage('session_replay', message);
  }

  return insert('session_replay', [message]);
}
