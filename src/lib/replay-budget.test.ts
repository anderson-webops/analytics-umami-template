import { beforeEach, expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { reserveCollectionAccountBudget } from '@/lib/collection-budget';
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_EVENTS,
  markAcknowledgedReplayChunk,
  markUnstoredReplayChunkRetryable,
  ReplayBudgetExceededError,
  ReplayWritePendingError,
  reserveReplayBudget,
} from './replay-budget';

vi.mock('@/lib/collection-budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/collection-budget')>()),
  reserveCollectionAccountBudget: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const args = {
  websiteId: '11111111-1111-4111-8111-111111111111',
  visitId: '22222222-2222-4222-8222-222222222222',
  accountType: 'user' as const,
  accountId: '33333333-3333-4333-8333-333333333333',
  chunkIndex: 100,
  idempotent: true,
  bytes: 100,
  events: 1,
  structureUnits: 1,
};

function transaction(responses: unknown[]) {
  const query = vi.fn().mockImplementation(async () => responses.shift());
  const execute = vi.fn().mockResolvedValue(0);

  return {
    client: { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient,
    query,
    execute,
  };
}

test('rejects oversized replay chunks before reserving database space', async () => {
  const { client, query } = transaction([]);

  await expect(
    reserveReplayBudget(client, { ...args, bytes: MAX_REPLAY_BYTES + 1 }),
  ).rejects.toBeInstanceOf(ReplayBudgetExceededError);
  await expect(
    reserveReplayBudget(client, { ...args, events: MAX_REPLAY_EVENTS + 1 }),
  ).rejects.toBeInstanceOf(ReplayBudgetExceededError);
  await expect(
    reserveReplayBudget(client, { ...args, structureUnits: 100_001 }),
  ).rejects.toBeInstanceOf(ReplayBudgetExceededError);
  expect(query).not.toHaveBeenCalled();
});

test('charges nested replay work to the durable visit and owner budgets', async () => {
  const { client, query } = transaction([
    [],
    [],
    [{ bytes: BigInt(MAX_REPLAY_BYTES) }],
    [{ bytes: BigInt(MAX_REPLAY_BYTES) }],
    [{ bytes: BigInt(MAX_REPLAY_BYTES) }],
    [{ chunks: 1 }],
    [{ chunks: 1 }],
    [{ requests: 1n }],
    [{ requests: 1n }],
  ]);

  expect(await reserveReplayBudget(client, { ...args, structureUnits: 100_000 })).toBe(true);
  expect(query.mock.calls[2]).toContain(MAX_REPLAY_BYTES);
  expect(reserveCollectionAccountBudget).toHaveBeenCalledWith(
    client,
    expect.anything(),
    expect.objectContaining({ bytes: MAX_REPLAY_BYTES + 512 }),
  );
});

test('returns an idempotent result for a previously accepted chunk', async () => {
  const { client, query, execute } = transaction([[], [{ chunkIndices: [args.chunkIndex] }]]);

  expect(await reserveReplayBudget(client, args)).toBe(false);
  expect(query).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
  expect(reserveCollectionAccountBudget).not.toHaveBeenCalled();
});

test('an external reservation remains pending until its sink acknowledges it', async () => {
  const { client, query, execute } = transaction([
    [],
    [],
    [{ bytes: 100n }],
    [{ bytes: 100n }],
    [{ bytes: 100n }],
    [{ chunks: 1 }],
    [{ chunks: 1 }],
    [{ requests: 1n }],
    [{ requests: 1n }],
  ]);

  expect(await reserveReplayBudget(client, { ...args, pendingExternalWrite: true })).toBe(true);
  expect(query.mock.calls[2]).toContain(-args.chunkIndex);
  expect(execute).toHaveBeenCalledOnce();
});

test('a concurrent retry cannot report success for a pending external write', async () => {
  const { client, query } = transaction([[], [{ chunkIndices: [-args.chunkIndex] }]]);

  await expect(reserveReplayBudget(client, args)).rejects.toBeInstanceOf(ReplayWritePendingError);
  expect(query).toHaveBeenCalledTimes(2);
  expect(reserveCollectionAccountBudget).not.toHaveBeenCalled();
});

test('only a pending external marker can be confirmed after sink acknowledgement', async () => {
  const { client, query } = transaction([[], [{ bytes: 100n }]]);

  await markAcknowledgedReplayChunk(client, args.websiteId, args.visitId, args.chunkIndex);
  expect(query.mock.calls[1][0].join('')).toContain('array_replace(chunk_indices,');
  expect(query.mock.calls[1]).toContain(-args.chunkIndex);
  expect(query.mock.calls[1]).toContain(args.chunkIndex);
});

test('a missing pending marker cannot be confirmed', async () => {
  const { client, query } = transaction([[], []]);

  await expect(
    markAcknowledgedReplayChunk(client, args.websiteId, args.visitId, args.chunkIndex),
  ).rejects.toThrow('Replay reservation completion failed.');
  expect(query).toHaveBeenCalledTimes(2);
});

test('an unwritten external chunk refunds only its visit reservation', async () => {
  const { client, query, execute } = transaction([[], [{ bytes: 0n }]]);

  await markUnstoredReplayChunkRetryable(client, args.websiteId, args.visitId, args.chunkIndex, {
    bytes: 100,
    events: 1,
  });

  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1][0].join('')).toContain('array_remove(chunk_indices,');
  expect(query.mock.calls[1][0].join('')).toContain('bytes -');
  expect(query.mock.calls[1][0].join('')).toContain('events -');
  expect(query.mock.calls[1][0].join('')).toContain('chunks - 1');
  expect(query.mock.calls[1]).toContain(args.chunkIndex);
  expect(query.mock.calls[1]).toContain(-args.chunkIndex);
  expect(execute).not.toHaveBeenCalled();
  expect(reserveCollectionAccountBudget).not.toHaveBeenCalled();
});

test('a missing or mismatched replay reservation cannot be refunded', async () => {
  const { client, query } = transaction([[], []]);

  await expect(
    markUnstoredReplayChunkRetryable(client, args.websiteId, args.visitId, args.chunkIndex, {
      bytes: 100,
      events: 1,
    }),
  ).rejects.toBeInstanceOf(ReplayBudgetExceededError);
  expect(query).toHaveBeenCalledTimes(2);
});

test('retrying a released chunk charges the current payload against every budget', async () => {
  const { client, query, execute } = transaction([
    [],
    [{ chunkIndices: [] }],
    [{ bytes: 200n }],
    [{ bytes: 200n }],
    [{ bytes: 200n }],
  ]);

  expect(await reserveReplayBudget(client, { ...args, bytes: 200 })).toBe(true);
  expect(query).toHaveBeenCalledTimes(5);
  expect(query.mock.calls[2][0].join('')).toContain(
    'array_append(replay_ingest_budget.chunk_indices,',
  );
  expect(query.mock.calls[2][0].join('')).toContain('bytes +');
  expect(query.mock.calls[2]).toContain(200);
  expect(reserveCollectionAccountBudget).toHaveBeenCalledWith(
    client,
    { accountType: args.accountType, accountId: args.accountId },
    { bytes: 712, rows: args.events, requests: 1 },
  );
  expect(execute).toHaveBeenCalledOnce();
});

test('an unwritten chunk retry fails closed when the larger payload exceeds its visit budget', async () => {
  const { client, query, execute } = transaction([[], [{ chunkIndices: [] }], []]);

  await expect(
    reserveReplayBudget(client, { ...args, bytes: MAX_REPLAY_BYTES }),
  ).rejects.toBeInstanceOf(ReplayBudgetExceededError);
  expect(query).toHaveBeenCalledTimes(3);
  expect(query.mock.calls[2][0].join('')).toContain('bytes +');
  expect(execute).not.toHaveBeenCalled();
  expect(reserveCollectionAccountBudget).not.toHaveBeenCalled();
});

test('blocks a source-minute budget without reporting a successful write', async () => {
  const { client, query, execute } = transaction([[], [], [{ bytes: 100n }], []]);

  await expect(reserveReplayBudget(client, args)).rejects.toMatchObject({ retryAfter: 60 });
  expect(query).toHaveBeenCalledTimes(4);
  expect(execute).not.toHaveBeenCalled();
});

test('blocks a source-day budget after the minute reservation', async () => {
  const { client, query, execute } = transaction([
    [],
    [],
    [{ bytes: 100n }],
    [{ bytes: 100n }],
    [],
  ]);

  await expect(reserveReplayBudget(client, args)).rejects.toMatchObject({ retryAfter: 86_400 });
  expect(query).toHaveBeenCalledTimes(5);
  expect(execute).not.toHaveBeenCalled();
});

test('reserves visit, minute, and day budgets for an ordinary chunk', async () => {
  const { client, query, execute } = transaction([
    [],
    [],
    [{ bytes: 100n }],
    [{ bytes: 100n }],
    [{ bytes: 100n }],
    [{ chunks: 1 }],
    [{ chunks: 1 }],
    [{ requests: 1n }],
    [{ requests: 1n }],
  ]);

  expect(await reserveReplayBudget(client, args)).toBe(true);
  expect(query).toHaveBeenCalledTimes(9);
  expect(execute).toHaveBeenCalledOnce();
  expect(reserveCollectionAccountBudget).toHaveBeenCalledWith(
    client,
    { accountType: args.accountType, accountId: args.accountId },
    { bytes: args.bytes + args.events * 512, rows: args.events, requests: 1 },
  );
  const visitExpiry = query.mock.calls[2].find(value => value instanceof Date);
  expect(visitExpiry).toBeInstanceOf(Date);
  expect(visitExpiry.getTime()).toBeGreaterThan(Date.now() + 37 * 24 * 60 * 60 * 1000);
  expect(visitExpiry.getTime()).toBeLessThan(Date.now() + 39 * 24 * 60 * 60 * 1000);
});

test('does not charge a new key when a visit already has a budget row', async () => {
  const { client, query } = transaction([
    [],
    [{ chunkIndices: [] }],
    [{ bytes: 100n }],
    [{ bytes: 100n }],
    [{ bytes: 100n }],
  ]);

  expect(await reserveReplayBudget(client, args)).toBe(true);
  expect(query).toHaveBeenCalledTimes(5);
  expect(reserveCollectionAccountBudget).toHaveBeenCalledWith(
    client,
    expect.objectContaining({ accountId: args.accountId }),
    expect.objectContaining({ rows: args.events }),
  );
});

test('rejects new replay visit keys when minute or day cardinality is exhausted', async () => {
  for (const [quotaResponses, retryAfter] of [
    [[[]], 60],
    [[[{ chunks: 1 }], []], 86_400],
  ] as const) {
    const { client, query, execute } = transaction([
      [],
      [],
      [{ bytes: 100n }],
      [{ bytes: 100n }],
      [{ bytes: 100n }],
      ...quotaResponses,
    ]);

    await expect(reserveReplayBudget(client, args)).rejects.toMatchObject({ retryAfter });
    expect(query).toHaveBeenCalledTimes(5 + quotaResponses.length);
    expect(execute).not.toHaveBeenCalled();
  }
});
