import { expect, test, vi } from 'vitest';
import redis from '@/lib/redis';
import { reserveAuthenticatedQueryLease } from './query-concurrency';

test('limits one viewer and releases capacity after its response', async () => {
  const userId = crypto.randomUUID();
  const websiteId = crypto.randomUUID();
  const leases = await Promise.all(
    Array.from({ length: 9 }, () => reserveAuthenticatedQueryLease(userId, websiteId, 1)),
  );

  expect(leases.filter(lease => !lease.blocked)).toHaveLength(8);
  expect(leases.filter(lease => lease.blocked)).toHaveLength(1);
  const independent = await reserveAuthenticatedQueryLease(
    crypto.randomUUID(),
    crypto.randomUUID(),
    1,
  );
  expect(independent.blocked).toBe(false);

  for (const lease of leases) {
    if ('release' in lease) await lease.release();
  }
  if ('release' in independent) await independent.release();

  const next = await reserveAuthenticatedQueryLease(userId, websiteId, 1);
  expect(next.blocked).toBe(false);
  if ('release' in next) await next.release();
});

test('charges weighted concurrent work to both viewer and website', async () => {
  const websiteId = crypto.randomUUID();
  const firstUserId = crypto.randomUUID();
  const first = await reserveAuthenticatedQueryLease(firstUserId, websiteId, 9_600);
  const second = await reserveAuthenticatedQueryLease(firstUserId, websiteId, 9_600);
  const blockedUser = await reserveAuthenticatedQueryLease(firstUserId, websiteId, 9_600);
  const third = await reserveAuthenticatedQueryLease(crypto.randomUUID(), websiteId, 9_600);
  const fourth = await reserveAuthenticatedQueryLease(crypto.randomUUID(), websiteId, 9_600);
  const blockedWebsite = await reserveAuthenticatedQueryLease(
    crypto.randomUUID(),
    websiteId,
    9_600,
  );

  expect([first, second, third, fourth].every(lease => !lease.blocked)).toBe(true);
  expect(blockedUser.blocked).toBe(true);
  expect(blockedWebsite.blocked).toBe(true);

  if ('release' in first) {
    await first.release();
    await first.release();
  }

  const afterRelease = await reserveAuthenticatedQueryLease(crypto.randomUUID(), websiteId, 9_600);
  expect(afterRelease.blocked).toBe(false);

  for (const lease of [second, third, fourth, afterRelease]) {
    if ('release' in lease) await lease.release();
  }
});

test('reserves slots for concurrent SQL fan-out even when date cost is small', async () => {
  const tenantId = crypto.randomUUID();
  const first = await reserveAuthenticatedQueryLease(crypto.randomUUID(), tenantId, 1, 7);
  const second = await reserveAuthenticatedQueryLease(crypto.randomUUID(), tenantId, 1, 7);
  const third = await reserveAuthenticatedQueryLease(crypto.randomUUID(), tenantId, 1, 7);

  expect(first.blocked).toBe(false);
  expect(second.blocked).toBe(false);
  expect(third.blocked).toBe(true);
  if ('release' in first) await first.release();
  if ('release' in second) await second.release();
});

test('does not fall back to process-local leases when configured Redis fails', async () => {
  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockRejectedValue(new Error('unavailable'));
  redis.enabled = true;

  try {
    expect(
      await reserveAuthenticatedQueryLease(crypto.randomUUID(), crypto.randomUUID(), 1),
    ).toMatchObject({ blocked: true, unavailable: true });
  } finally {
    redis.enabled = enabled;
    connect.mockRestore();
  }
});

test('reserves and releases both distributed keys atomically', async () => {
  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockResolvedValue();
  const occupied = new Map<string, Set<string>>();
  const withAbortSignal = vi.spyOn(redis.client.client, 'withAbortSignal').mockImplementation(
    () =>
      ({
        eval: (script: string, options: { keys: string[]; arguments: string[] }) => {
          const { keys, arguments: args } = options;
          if (script.includes('ZREMRANGEBYSCORE')) {
            const slots = Number(args[0]);
            const capacities = args.slice(3).map(Number);
            if (
              keys.some((key, index) => (occupied.get(key)?.size ?? 0) + slots > capacities[index])
            ) {
              return Promise.resolve(0);
            }
            for (const key of keys) {
              const tokens = occupied.get(key) ?? new Set<string>();
              for (let slot = 1; slot <= slots; slot++) tokens.add(`${args[2]}:${slot}`);
              occupied.set(key, tokens);
            }
            return Promise.resolve(1);
          }
          for (const key of keys) {
            const tokens = occupied.get(key);
            for (let slot = 1; slot <= Number(args[1]); slot++)
              tokens?.delete(`${args[0]}:${slot}`);
          }
          return Promise.resolve(1);
        },
      }) as any,
  );
  redis.enabled = true;

  try {
    const websiteId = crypto.randomUUID();
    const admitted = await Promise.all(
      Array.from({ length: 5 }, () =>
        reserveAuthenticatedQueryLease(crypto.randomUUID(), websiteId, 9_600),
      ),
    );

    expect(admitted.filter(lease => !lease.blocked)).toHaveLength(4);
    expect(admitted.filter(lease => lease.blocked)).toHaveLength(1);
    for (const lease of admitted) {
      if ('release' in lease) await lease.release();
    }
    const afterRelease = await reserveAuthenticatedQueryLease(
      crypto.randomUUID(),
      websiteId,
      9_600,
    );
    expect(afterRelease.blocked).toBe(false);
    if ('release' in afterRelease) await afterRelease.release();
  } finally {
    redis.enabled = enabled;
    connect.mockRestore();
    withAbortSignal.mockRestore();
  }
});
