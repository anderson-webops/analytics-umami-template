import { beforeEach, expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { type HeatmapEventRow, saveHeatmapEvents } from './saveHeatmapEvents';

const { createMany, runTransaction, insert, sendMessage, state } = vi.hoisted(() => ({
  createMany: vi.fn(),
  runTransaction: vi.fn(),
  insert: vi.fn(),
  sendMessage: vi.fn(),
  state: { mode: 'prisma', kafka: false },
}));

vi.mock('@/lib/prisma', () => ({
  default: { transaction: runTransaction },
}));

vi.mock('@/lib/db', () => ({
  PRISMA: 'prisma',
  CLICKHOUSE: 'clickhouse',
  runQuery: (queries: Record<string, () => unknown>) => queries[state.mode](),
}));

vi.mock('@/lib/clickhouse', () => ({
  default: { insert, getUTCString: (date: Date) => date.toISOString() },
}));
vi.mock('@/lib/kafka', () => ({
  default: {
    get enabled() {
      return state.kafka;
    },
    sendMessage,
  },
}));

const row: HeatmapEventRow = {
  websiteId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  visitId: '33333333-3333-4333-8333-333333333333',
  urlPath: '/',
  eventType: 1,
  x: 1,
  y: 2,
  pageX: null,
  pageY: null,
  pageW: null,
  viewportW: null,
  viewportH: null,
  pageH: null,
  scrollPct: null,
  createdAt: new Date('2026-10-10T00:00:00Z'),
};

const transaction = {
  heatmapEvent: { createMany },
} as unknown as Prisma.TransactionClient;

beforeEach(() => {
  vi.clearAllMocks();
  createMany.mockResolvedValue({ count: 1 });
  runTransaction.mockImplementation(operation => operation(transaction));
  state.mode = 'prisma';
  state.kafka = false;
});

test('uses the database expiration default without adding cleanup work to intake', async () => {
  await expect(saveHeatmapEvents([row], transaction)).resolves.toEqual({ count: 1 });

  expect(createMany).toHaveBeenCalledOnce();
  expect(createMany.mock.calls[0][0].data[0]).not.toHaveProperty('retentionExpiresAt');
});

test('propagates insertion failure without unrelated cleanup', async () => {
  createMany.mockRejectedValueOnce(new Error('write failed'));
  await expect(saveHeatmapEvents([row], transaction)).rejects.toThrow('write failed');
});

test('keeps the non-transactional caller on the normal write path', async () => {
  await expect(saveHeatmapEvents([row])).resolves.toEqual({ count: 1 });
  expect(runTransaction).toHaveBeenCalledOnce();
  expect(createMany).toHaveBeenCalledOnce();
});

test.each([false, true])(
  'marks new external heatmap rows for sink retention (Kafka: %s)',
  async kafka => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T01:02:03Z'));
    state.mode = 'clickhouse';
    state.kafka = kafka;

    try {
      await saveHeatmapEvents([row]);

      const messages = kafka ? sendMessage.mock.calls[0][1] : insert.mock.calls[0][1];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        retention_policy: 1,
        ingested_at: '2026-10-11T01:02:03.000Z',
        website_id: row.websiteId,
      });
      expect(messages[0].ingested_at).not.toBe(messages[0].created_at);
      expect(runTransaction).not.toHaveBeenCalled();
      expect(createMany).not.toHaveBeenCalled();
      expect(kafka ? sendMessage : insert).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);
