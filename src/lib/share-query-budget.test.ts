import { expect, test, vi } from 'vitest';
import redis from '@/lib/redis';
import { getShareQueryCost, reserveShareQueryCost } from './share-query-budget';

test('rejects excessive GET and report property-filter fan-out', () => {
  const manyProperties = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [`pf_plan${index}`, '1.eq.pro']),
  );

  expect(getShareQueryCost({ ...manyProperties, startAt: 1, endAt: 2 })).toBeNull();
  expect(getShareQueryCost({}, { filters: manyProperties })).toBeNull();
  expect(
    getShareQueryCost({
      startAt: 1,
      endAt: 2,
      steps: [{ filters: Array.from({ length: 17 }, () => ({ property: 'plan' })) }],
    }),
  ).toBeNull();
});

test('weights date range and filters without rejecting ordinary shares', () => {
  const startAt = Date.UTC(2025, 0, 1);
  const endAt = Date.UTC(2025, 11, 31);

  expect(getShareQueryCost({ startAt, endAt })).toEqual({ cost: 12, charge: 12 });
  expect(getShareQueryCost({ startAt, endAt, pf_plan: '1.eq.pro' })).toEqual({
    cost: 60,
    charge: 60,
  });
  expect(getShareQueryCost({ startAt, endAt, segment: 'saved-segment' })).toBeNull();
  expect(getShareQueryCost({ startAt: endAt, endAt: startAt })).toBeNull();
});

test('uses executed POST dates over unrelated URL dates', () => {
  const result = getShareQueryCost(
    { startAt: 0, endAt: 1 },
    {
      parameters: {
        startDate: new Date(Date.UTC(2006, 0, 1)),
        endDate: new Date(Date.UTC(2025, 11, 31)),
        steps: [{ filters: [{ property: 'plan' }] }],
      },
    },
  );

  expect(result).toBeNull();
});

test('charges the full historical range and each aggregate scan', () => {
  const startAt = Date.UTC(2006, 0, 1);
  const endAt = Date.UTC(2025, 11, 31);
  const result = getShareQueryCost({ startAt, endAt });

  expect(result?.cost).toBeGreaterThan(200);
  expect(result?.charge).toBe(result?.cost);
  expect(getShareQueryCost({ startAt, endAt }, undefined, 2)?.charge).toBe((result?.cost ?? 0) * 2);
  expect(
    getShareQueryCost(
      { startAt, endAt: Date.UTC(2006, 0, 31), segment: 'saved-segment' },
      undefined,
      2,
    ),
  ).toEqual({ cost: 401, charge: 600 });
});

test('prices saved segments at their maximum stored filter fan-out', () => {
  const startAt = Date.UTC(2025, 0, 1);
  const endAt = Date.UTC(2025, 0, 31);

  expect(getShareQueryCost({ startAt, endAt, segment: 'saved-segment' })).toEqual({
    cost: 401,
    charge: 401,
  });
  expect(
    getShareQueryCost({ startAt, endAt: Date.UTC(2025, 1, 28), cohort: 'saved-cohort' }),
  ).toBeNull();
});

test('bounds repeated queries per share in a fixed window', async () => {
  const shareId = `budget-test-${crypto.randomUUID()}`;

  expect((await reserveShareQueryCost(shareId, 600)).blocked).toBe(false);
  expect((await reserveShareQueryCost(shareId, 1)).blocked).toBe(true);
});

test('fails closed within a deadline when Redis is reconnecting', async () => {
  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockResolvedValue();
  const withAbortSignal = vi.spyOn(redis.client.client, 'withAbortSignal').mockImplementation(
    signal =>
      ({
        eval: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }) as any,
  );
  redis.enabled = true;

  try {
    const start = Date.now();
    const result = await reserveShareQueryCost(`reconnecting-${crypto.randomUUID()}`, 1);

    expect(result.unavailable).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  } finally {
    redis.enabled = enabled;
    connect.mockRestore();
    withAbortSignal.mockRestore();
  }
});
