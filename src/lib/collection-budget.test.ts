import { expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import {
  COLLECTION_ANONYMOUS_BUDGET_LIMITS,
  COLLECTION_BUDGET_LIMITS,
  COLLECTION_CLIENT_BUDGET_LIMITS,
  CollectionBudgetExceededError,
  getCollectionCost,
  reserveCollectionAccountBudget,
  reserveCollectionBudget,
  reserveCollectionClientBudget,
} from './collection-budget';
import { getCollectionClientKeys } from './collection-client-key';

const identity = {
  sourceType: 'website' as const,
  sourceId: '11111111-1111-4111-8111-111111111111',
  accountType: 'user' as const,
  accountId: '22222222-2222-4222-8222-222222222222',
  ...getCollectionClientKeys(
    'website',
    '11111111-1111-4111-8111-111111111111',
    'user',
    '22222222-2222-4222-8222-222222222222',
    '192.0.2.10',
  ),
};
const cost = { bytes: 2_048, rows: 3, requests: 1 };

test('anonymous source and owner envelopes leave capacity for backend submissions', () => {
  for (const scope of ['minute', 'day'] as const) {
    for (const measure of ['bytes', 'rows', 'requests'] as const) {
      expect(COLLECTION_CLIENT_BUDGET_LIMITS.send[scope][measure]).toBeLessThan(
        COLLECTION_ANONYMOUS_BUDGET_LIMITS.source[scope][measure],
      );
      expect(COLLECTION_ANONYMOUS_BUDGET_LIMITS.source[scope][measure]).toBeLessThan(
        COLLECTION_BUDGET_LIMITS.source[scope][measure],
      );
      expect(COLLECTION_ANONYMOUS_BUDGET_LIMITS.account[scope][measure]).toBeLessThan(
        COLLECTION_BUDGET_LIMITS.account[scope][measure],
      );
    }
  }
});

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

test('client keys separate sources and IPs while sharing an owner across sources', () => {
  const sourceA = getCollectionClientKeys(
    'website',
    identity.sourceId,
    'user',
    identity.accountId,
    '192.0.2.10',
  );
  const sourceB = getCollectionClientKeys(
    'website',
    '33333333-3333-4333-8333-333333333333',
    'user',
    identity.accountId,
    '192.0.2.10',
  );
  const otherClient = getCollectionClientKeys(
    'website',
    identity.sourceId,
    'user',
    identity.accountId,
    '192.0.2.11',
  );

  expect(sourceA.sourceClientHash).not.toBe(sourceB.sourceClientHash);
  expect(sourceA.accountClientHash).toBe(sourceB.accountClientHash);
  expect(sourceA.sourceClientHash).not.toBe(otherClient.sourceClientHash);
  expect(sourceA.accountClientHash).not.toBe(otherClient.accountClientHash);
  expect(JSON.stringify(sourceA)).not.toContain('192.0.2.10');
});

test('backend and anonymous traffic from one IP cannot consume each others client budgets', () => {
  const anonymousKeys = getCollectionClientKeys(
    identity.sourceType,
    identity.sourceId,
    identity.accountType,
    identity.accountId,
    '192.0.2.10',
    'anonymous',
  );
  const backendKeys = getCollectionClientKeys(
    identity.sourceType,
    identity.sourceId,
    identity.accountType,
    identity.accountId,
    '192.0.2.10',
    'backend',
  );

  expect(backendKeys.sourceClientHash).not.toBe(anonymousKeys.sourceClientHash);
  expect(backendKeys.accountClientHash).not.toBe(anonymousKeys.accountClientHash);
  expect(JSON.stringify(backendKeys)).not.toContain('192.0.2.10');
});

test('identify, performance, and team-owned sources use the same budget boundary', async () => {
  expect(getCollectionCost({ type: 'identify', payload: { data: { key: 'value' } } }).rows).toBe(5);
  expect(getCollectionCost({ type: 'performance', payload: {} }).rows).toBe(2);

  const { client, query } = transaction([
    [{ currentTime: new Date('2026-10-06T11:30:00Z') }],
    ...Array.from({ length: 8 }, () => [{ requests: 2n }]),
  ]);

  await reserveCollectionBudget(
    client,
    {
      ...identity,
      accountType: 'team',
      ...getCollectionClientKeys(
        identity.sourceType,
        identity.sourceId,
        'team',
        identity.accountId,
        '192.0.2.10',
      ),
    },
    cost,
    'backend',
  );
  expect(query.mock.calls[7][1]).toBe('team');
  expect(query.mock.calls[7][2]).toBe(identity.accountId);
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
    ...Array.from({ length: 8 }, () => [{ requests: 1n }]),
  ]);

  await reserveCollectionBudget(client, identity, cost, 'backend');

  expect(query).toHaveBeenCalledTimes(9);
  expect(query.mock.calls.slice(1).map(call => call.slice(1, 4))).toEqual([
    ['source', `client:send:${identity.sourceClientHash}`, 'minute'],
    ['source', `client:send:${identity.sourceClientHash}`, 'day'],
    ['source', `client:account:${identity.accountClientHash}`, 'minute'],
    ['source', `client:account:${identity.accountClientHash}`, 'day'],
    ['source', `website:${identity.sourceId}`, 'minute'],
    ['source', `website:${identity.sourceId}`, 'day'],
    ['user', identity.accountId, 'minute'],
    ['user', identity.accountId, 'day'],
  ]);
  expect(execute).toHaveBeenCalledOnce();
});

test('anonymous clients charge capped source and owner lanes before shared capacity', async () => {
  const { client, query } = transaction([
    [{ currentTime: new Date('2026-10-06T11:30:00Z') }],
    ...Array.from({ length: 12 }, () => [{ requests: 1n }]),
  ]);

  await reserveCollectionBudget(client, identity, cost, 'anonymous');

  expect(query.mock.calls.slice(1).map(call => call.slice(1, 4))).toEqual([
    ['source', `client:send:${identity.sourceClientHash}`, 'minute'],
    ['source', `client:send:${identity.sourceClientHash}`, 'day'],
    ['source', `client:account:${identity.accountClientHash}`, 'minute'],
    ['source', `client:account:${identity.accountClientHash}`, 'day'],
    ['source', `anonymous:website:${identity.sourceId}`, 'minute'],
    ['source', `anonymous:website:${identity.sourceId}`, 'day'],
    ['user', `anonymous:${identity.accountId}`, 'minute'],
    ['user', `anonymous:${identity.accountId}`, 'day'],
    ['source', `website:${identity.sourceId}`, 'minute'],
    ['source', `website:${identity.sourceId}`, 'day'],
    ['user', identity.accountId, 'minute'],
    ['user', identity.accountId, 'day'],
  ]);
});

test('anonymous lane exhaustion rejects before charging the shared envelopes', async () => {
  const { client, query } = transaction([
    [{ currentTime: new Date('2026-10-06T11:30:00Z') }],
    ...Array.from({ length: 4 }, () => [{ requests: 1n }]),
    [],
  ]);

  await expect(reserveCollectionBudget(client, identity, cost, 'anonymous')).rejects.toMatchObject({
    retryAfter: 60,
  });
  expect(query).toHaveBeenCalledTimes(6);
});

test.each(['replay', 'heatmap'] as const)(
  '%s reservations charge the client source and owner before recorder persistence',
  async kind => {
    const { client, query } = transaction([
      [{ currentTime: new Date('2026-10-06T11:30:00Z') }],
      ...Array.from({ length: 4 }, () => [{ requests: 1n }]),
    ]);

    await reserveCollectionClientBudget(client, identity, kind, cost);

    expect(query.mock.calls.slice(1).map(call => call[2])).toEqual([
      `client:${kind}:${identity.sourceClientHash}`,
      `client:${kind}:${identity.sourceClientHash}`,
      `client:account:${identity.accountClientHash}`,
      `client:account:${identity.accountClientHash}`,
    ]);
  },
);

test('an exhausted client budget fails before charging the shared source or owner', async () => {
  const { client, query } = transaction([[{ currentTime: new Date('2026-10-06T11:30:00Z') }], []]);

  await expect(reserveCollectionBudget(client, identity, cost)).rejects.toMatchObject({
    retryAfter: 60,
  });
  expect(query).toHaveBeenCalledTimes(2);
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
  const source = transaction([clock, ...Array.from({ length: 4 }, () => [{ requests: 2n }]), []]);

  await expect(
    reserveCollectionBudget(source.client, identity, cost, 'backend'),
  ).rejects.toMatchObject({
    retryAfter: 60,
  });
  expect(source.execute).not.toHaveBeenCalled();

  const account = transaction([clock, ...Array.from({ length: 7 }, () => [{ requests: 2n }]), []]);

  await expect(
    reserveCollectionBudget(account.client, identity, cost, 'backend'),
  ).rejects.toMatchObject({
    retryAfter: 86_400,
  });
  expect(account.execute).not.toHaveBeenCalled();
});
