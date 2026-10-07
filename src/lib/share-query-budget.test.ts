import { expect, test, vi } from 'vitest';
import { getCompareDate } from '@/lib/date';
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
  ).toEqual({ cost: 401, charge: 802 });
});

test('charges report fan-out and covers a longer year-over-year comparison range', () => {
  const startDate = new Date('2025-01-29T12:00:00.000Z');
  const endDate = new Date('2025-03-01T12:00:00.000Z');
  const body = { parameters: { startDate, endDate }, filters: {} };
  const comparison = { parameters: getCompareDate('yoy', startDate, endDate) };

  expect(getShareQueryCost({}, body)).toEqual({ cost: 1, charge: 1 });
  expect(getShareQueryCost({}, comparison)).toEqual({ cost: 2, charge: 2 });
  expect(getShareQueryCost({}, body, 5)?.charge).toBe(5);
  expect(getShareQueryCost({}, body, 6)?.charge).toBe(6);
  expect(getShareQueryCost({}, body, 8)?.charge).toBe(8);
  expect(getShareQueryCost({}, body, 8)?.charge).toBe(
    6 * (getShareQueryCost({}, body)?.cost ?? 0) + (getShareQueryCost({}, comparison)?.cost ?? 0),
  );
  expect(getShareQueryCost({}, body, 3)?.charge).toBe(3);
});

test('rejects invalid work multipliers rather than weakening share charges', () => {
  expect(getShareQueryCost({}, undefined, 0 as 1)).toBeNull();
  expect(getShareQueryCost({}, undefined, 9 as 1)).toBeNull();
  expect(getShareQueryCost({}, undefined, 1.5 as 1)).toBeNull();
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

test('records complete multi-query work while allowing only one oversized request per window', async () => {
  const shareId = `historical-report-${crypto.randomUUID()}`;
  const budget = getShareQueryCost(
    { startAt: Date.UTC(2006, 0, 1), endAt: Date.UTC(2025, 11, 31) },
    undefined,
    8,
  );

  const charge = budget?.charge ?? 0;
  expect(charge).toBe((budget?.cost ?? 0) * 8);
  expect(charge).toBeGreaterThan(600);
  expect((await reserveShareQueryCost(shareId, charge)).blocked).toBe(false);
  expect((await reserveShareQueryCost(shareId, charge)).blocked).toBe(true);
});

test('Redis reservations block the second oversized request', async () => {
  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockResolvedValue();
  let total = 0;
  const withAbortSignal = vi.spyOn(redis.client.client, 'withAbortSignal').mockImplementation(
    () =>
      ({
        eval: (_script: string, options: { arguments: string[] }) => {
          total += Number(options.arguments[0]);
          return Promise.resolve(total);
        },
      }) as any,
  );
  redis.enabled = true;

  try {
    const shareId = `redis-historical-report-${crypto.randomUUID()}`;
    expect((await reserveShareQueryCost(shareId, 1888)).blocked).toBe(false);
    expect((await reserveShareQueryCost(shareId, 1888)).blocked).toBe(true);
  } finally {
    redis.enabled = enabled;
    connect.mockRestore();
    withAbortSignal.mockRestore();
  }
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
