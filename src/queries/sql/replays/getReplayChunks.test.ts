import { gzipSync } from 'node:zlib';
import { beforeEach, expect, test, vi } from 'vitest';
import clickhouse from '@/lib/clickhouse';
import prisma from '@/lib/prisma';
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_CHUNKS,
  MAX_REPLAY_STORED_BYTES,
  ReplayBudgetExceededError,
} from '@/lib/replay-budget';
import { getReplayChunks } from './getReplayChunks';

const state = vi.hoisted(() => ({ backend: 'prisma' }));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => Promise<unknown>>) => queries[state.backend](),
}));

vi.mock('@/lib/prisma', () => ({ default: { rawQuery: vi.fn() } }));
vi.mock('@/lib/clickhouse', () => ({ default: { rawQuery: vi.fn() } }));

const prismaQuery = vi.mocked(prisma.rawQuery);
const clickhouseQuery = vi.mocked(clickhouse.rawQuery);
const websiteId = '11111111-1111-4111-8111-111111111111';
const visitId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  state.backend = 'prisma';
});

test('relational replay reads guard stored bytes before returning payloads', async () => {
  prismaQuery.mockResolvedValue([
    {
      sessionId: 'session',
      visitId,
      events: null,
      chunkIndex: 1,
      eventCount: 1,
      startedAt: new Date(),
      endedAt: new Date(),
      totalChunks: 1n,
      storedBytes: BigInt(MAX_REPLAY_STORED_BYTES + 1),
    },
  ]);

  await expect(getReplayChunks(websiteId, visitId)).rejects.toBeInstanceOf(
    ReplayBudgetExceededError,
  );
  expect(prismaQuery.mock.calls[0][0]).toContain('then replay.events else null');
  expect(prismaQuery.mock.calls[0][0]).toContain(`limit ${MAX_REPLAY_CHUNKS + 1}`);
});

test('relational replay reads reject decompression beyond the aggregate budget', async () => {
  prismaQuery.mockResolvedValue([
    {
      sessionId: 'session',
      visitId,
      events: gzipSync(Buffer.alloc(MAX_REPLAY_BYTES + 1, 'x')),
      chunkIndex: 1,
      eventCount: 1,
      startedAt: new Date(),
      endedAt: new Date(),
      totalChunks: 1n,
      storedBytes: 10n,
    },
  ]);

  await expect(getReplayChunks(websiteId, visitId)).rejects.toBeInstanceOf(
    ReplayBudgetExceededError,
  );
});

test('corrupt stored replay data remains a storage error rather than a budget response', async () => {
  prismaQuery.mockResolvedValue([
    {
      sessionId: 'session',
      visitId,
      events: Buffer.from('invalid gzip'),
      chunkIndex: 1,
      eventCount: 1,
      startedAt: new Date(),
      endedAt: new Date(),
      totalChunks: 1n,
      storedBytes: 12n,
    },
  ]);

  await expect(getReplayChunks(websiteId, visitId)).rejects.toMatchObject({
    code: 'Z_DATA_ERROR',
  });
});

test('ordinary relational replay remains readable', async () => {
  const events = [{ type: 4, timestamp: 123, data: { width: 100 } }];
  const encoded = gzipSync(Buffer.from(JSON.stringify(events)));
  prismaQuery.mockResolvedValue([
    {
      sessionId: 'session',
      visitId,
      events: encoded,
      chunkIndex: 1,
      eventCount: 1,
      startedAt: new Date(),
      endedAt: new Date(),
      totalChunks: 1n,
      storedBytes: BigInt(MAX_REPLAY_BYTES + 1),
    },
  ]);

  expect((await getReplayChunks(websiteId, visitId))[0].events).toEqual(events);
});

test('ClickHouse replay reads guard oversized data and preserve ordinary reads', async () => {
  state.backend = 'clickhouse';
  const row = {
    sessionId: 'session',
    visitId,
    events: '',
    chunk_index: 1,
    event_count: 1,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    totalChunks: MAX_REPLAY_CHUNKS + 1,
    storedBytes: MAX_REPLAY_BYTES + 1,
  };
  clickhouseQuery.mockResolvedValueOnce([row]).mockResolvedValueOnce([
    {
      ...row,
      events: JSON.stringify([{ type: 4, timestamp: 123 }]),
      totalChunks: 1,
      storedBytes: 30,
    },
  ]);

  await expect(getReplayChunks(websiteId, visitId)).rejects.toBeInstanceOf(
    ReplayBudgetExceededError,
  );
  expect(clickhouseQuery.mock.calls[0][0]).toContain(`limit ${MAX_REPLAY_CHUNKS + 1}`);
  expect((await getReplayChunks(websiteId, visitId))[0].events).toEqual([
    { type: 4, timestamp: 123 },
  ]);
});
