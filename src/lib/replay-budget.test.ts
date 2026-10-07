import { expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_EVENTS,
  ReplayBudgetExceededError,
  reserveReplayBudget,
} from './replay-budget';

const args = {
  websiteId: '11111111-1111-4111-8111-111111111111',
  visitId: '22222222-2222-4222-8222-222222222222',
  chunkIndex: 100,
  idempotent: true,
  bytes: 100,
  events: 1,
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
  expect(query).not.toHaveBeenCalled();
});

test('returns an idempotent result for a previously accepted chunk', async () => {
  const { client, query, execute } = transaction([[], [{ chunkIndices: [args.chunkIndex] }]]);

  expect(await reserveReplayBudget(client, args)).toBe(false);
  expect(query).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
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
  ]);

  expect(await reserveReplayBudget(client, args)).toBe(true);
  expect(query).toHaveBeenCalledTimes(5);
  expect(execute).toHaveBeenCalledOnce();
  const visitExpiry = query.mock.calls[2].find(value => value instanceof Date);
  expect(visitExpiry).toBeInstanceOf(Date);
  expect(visitExpiry.getTime()).toBeGreaterThan(Date.now() + 37 * 24 * 60 * 60 * 1000);
  expect(visitExpiry.getTime()).toBeLessThan(Date.now() + 39 * 24 * 60 * 60 * 1000);
});
