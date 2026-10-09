import { expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import {
  CollectionBudgetExceededError,
  getCollectionCost,
  reserveCollectionAccountBudget,
  reserveCollectionBudget,
} from './collection-budget';

const identity = {
  sourceType: 'website' as const,
  sourceId: '11111111-1111-4111-8111-111111111111',
  accountType: 'user' as const,
  accountId: '22222222-2222-4222-8222-222222222222',
};
const cost = { bytes: 2_048, rows: 3, requests: 1 };

function transaction(responses: unknown[]) {
  const query = vi.fn().mockImplementation(async () => responses.shift());
  const execute = vi.fn().mockResolvedValue(0);

  return {
    client: { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient,
    query,
    execute,
  };
}

test('property-rich events consume rows and bytes proportional to persisted work', () => {
  const ordinary = getCollectionCost({ type: 'event', payload: {} });
  const rich = getCollectionCost({
    type: 'event',
    payload: {
      data: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, 'x'])),
    },
  });

  expect(ordinary.rows).toBe(2);
  expect(rich.rows).toBe(102);
  expect(rich.bytes).toBeGreaterThan(ordinary.bytes + 100 * 512);
  expect(rich.requests).toBe(1);
});

test('identify, performance, and team-owned sources use the same budget boundary', async () => {
  expect(getCollectionCost({ type: 'identify', payload: { data: { key: 'value' } } }).rows).toBe(5);
  expect(getCollectionCost({ type: 'performance', payload: {} }).rows).toBe(2);

  const { client, query } = transaction([
    [{ currentTime: new Date('2026-10-06T11:30:00Z') }],
    [{ requests: 2n }],
    [{ requests: 2n }],
    [{ requests: 2n }],
    [{ requests: 2n }],
  ]);

  await reserveCollectionBudget(client, { ...identity, accountType: 'team' }, cost);
  expect(query.mock.calls[3][1]).toBe('team');
  expect(query.mock.calls[3][2]).toBe(identity.accountId);
});

test('invalid costs fail before any database reservation', async () => {
  const { client, query } = transaction([]);

  await expect(
    reserveCollectionBudget(client, identity, { ...cost, rows: 0 }),
  ).rejects.toBeInstanceOf(CollectionBudgetExceededError);
  expect(query).not.toHaveBeenCalled();
});

test('source and account minute/day reservations use distinct atomic keys', async () => {
  const { client, query, execute } = transaction([
    [{ currentTime: new Date('2026-10-06T11:30:00Z') }],
    [{ requests: 1n }],
    [{ requests: 1n }],
    [{ requests: 1n }],
    [{ requests: 1n }],
  ]);

  await reserveCollectionBudget(client, identity, cost);

  expect(query).toHaveBeenCalledTimes(5);
  expect(query.mock.calls.slice(1).map(call => call.slice(1, 4))).toEqual([
    ['source', `website:${identity.sourceId}`, 'minute'],
    ['source', `website:${identity.sourceId}`, 'day'],
    ['user', identity.accountId, 'minute'],
    ['user', identity.accountId, 'day'],
  ]);
  expect(execute).toHaveBeenCalledOnce();
});

test('recorder reservations share owner windows without reducing recorder-specific website limits', async () => {
  const { client, query, execute } = transaction([
    [{ currentTime: new Date('2026-10-06T11:30:00Z') }],
    [{ requests: 1n }],
    [{ requests: 1n }],
  ]);

  await reserveCollectionAccountBudget(client, identity, cost);

  expect(query).toHaveBeenCalledTimes(3);
  expect(query.mock.calls.slice(1).map(call => call.slice(1, 4))).toEqual([
    ['user', identity.accountId, 'minute'],
    ['user', identity.accountId, 'day'],
  ]);
  expect(execute).toHaveBeenCalledOnce();
});

test('recorder account-only reservations reject an exhausted owner window', async () => {
  const { client, query, execute } = transaction([
    [{ currentTime: new Date('2026-10-06T11:30:00Z') }],
    [{ requests: 1n }],
    [],
  ]);

  await expect(reserveCollectionAccountBudget(client, identity, cost)).rejects.toMatchObject({
    retryAfter: 86_400,
  });
  expect(query).toHaveBeenCalledTimes(3);
  expect(execute).not.toHaveBeenCalled();
});

test('exhausted source and account windows fail with bounded retry intervals', async () => {
  const clock = [{ currentTime: new Date('2026-10-06T11:30:00Z') }];
  const source = transaction([clock, []]);

  await expect(reserveCollectionBudget(source.client, identity, cost)).rejects.toMatchObject({
    retryAfter: 60,
  });
  expect(source.execute).not.toHaveBeenCalled();

  const account = transaction([
    clock,
    [{ requests: 2n }],
    [{ requests: 2n }],
    [{ requests: 2n }],
    [],
  ]);

  await expect(reserveCollectionBudget(account.client, identity, cost)).rejects.toMatchObject({
    retryAfter: 86_400,
  });
  expect(account.execute).not.toHaveBeenCalled();
});
