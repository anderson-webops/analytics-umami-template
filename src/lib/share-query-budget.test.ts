import { expect, test, vi } from 'vitest';
import { getCompareDate } from '@/lib/date';
import redis from '@/lib/redis';
import {
  getAuthenticatedQueryCost,
  getBreakdownShareWorkMultiplier,
  getEventSeriesShareWorkMultiplier,
  getFunnelShareWorkMultiplier,
  getGoalShareWorkMultiplier,
  getJourneyShareWorkMultiplier,
  getMetricShareWorkMultiplier,
  getPagedShareWorkMultiplier,
  getPageviewShareWorkMultiplier,
  getShareQueryCost,
  getValuesShareWorkMultiplier,
  isBoundedBreakdownShape,
  reserveAuthenticatedQueryCost,
  reserveShareQueryCost as reserveShareQueryCostForRequest,
  reserveTenantQueryCost,
  reserveTenantQueryCosts,
} from './share-query-budget';

const reserveShareQueryCost = (shareId: string, cost: number, requestCount: 0 | 1 = 1) =>
  reserveShareQueryCostForRequest(
    shareId,
    cost,
    new Request('https://analytics.example'),
    requestCount,
  );

test('reserves a multi-owner budget in one distributed admission operation', async () => {
  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockResolvedValue();
  const evalMock = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
  const withAbortSignal = vi
    .spyOn(redis.client.client, 'withAbortSignal')
    .mockImplementation(() => ({ eval: evalMock }) as any);
  redis.enabled = true;

  try {
    const costs = new Map([
      [`team:${crypto.randomUUID()}`, 10],
      [`team:${crypto.randomUUID()}`, 20],
    ]);
    expect((await reserveTenantQueryCosts(costs)).blocked).toBe(true);
    expect((await reserveTenantQueryCosts(costs)).blocked).toBe(false);
    expect(evalMock).toHaveBeenCalledTimes(2);
    for (const [, options] of evalMock.mock.calls) {
      expect(options.keys).toHaveLength(4);
      expect(options.arguments).toEqual(['10', '20', '40000', '120', '60']);
    }
  } finally {
    redis.enabled = enabled;
    connect.mockRestore();
    withAbortSignal.mockRestore();
  }
});

test('bounds breakdown dimensions by scanned time range', () => {
  const start = Date.UTC(2025, 0, 1);
  const days = (count: number) => start + count * 86_400_000;

  expect(isBoundedBreakdownShape(Array(20).fill('path'), start, days(31))).toBe(true);
  expect(isBoundedBreakdownShape(Array(20).fill('path'), start, days(32))).toBe(false);
  expect(isBoundedBreakdownShape(Array(8).fill('path'), start, days(366))).toBe(true);
  expect(isBoundedBreakdownShape(Array(8).fill('path'), start, days(367))).toBe(false);
  expect(isBoundedBreakdownShape(['path', 'country'], start, days(5 * 366))).toBe(true);
  expect(isBoundedBreakdownShape(['path', 'country'], start, days(5 * 366 + 1))).toBe(false);
});

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

test('prices parsed regex operators instead of their filter keys', () => {
  const range = { startAt: 0, endAt: 1 };

  expect(getShareQueryCost({ ...range, path: 'eq.re.literal' })).toEqual({ cost: 2, charge: 2 });
  expect(getShareQueryCost({ ...range, path: 're.^/private' })).toEqual({
    cost: 201,
    charge: 201,
  });
  expect(getShareQueryCost({ ...range, path: 'nre.^/private' })).toEqual({
    cost: 201,
    charge: 201,
  });
  expect(getShareQueryCost({ ...range, path1: 're.^/private' })?.charge).toBe(201);
  expect(getShareQueryCost({ ...range, pf_plan: '1.re.^pro' })?.charge).toBe(201);
  expect(getShareQueryCost({ ...range, pf_plan: 'nre.^pro' })?.charge).toBe(201);
  expect(getShareQueryCost({ ...range, epf0: '1.nre.plan.^pro' })?.charge).toBe(201);
  expect(getShareQueryCost({ ...range, spf0: '1.re.plan.^pro' })?.charge).toBe(201);
  expect(getShareQueryCost(range, { filters: { path: 're.^/private' } })?.charge).toBe(201);
  expect(getShareQueryCost({ ...range, search: 're.literal' })).toEqual({
    cost: 2,
    charge: 2,
  });
  expect(getShareQueryCost({ ...range, path: 're.a', referrer: 'nre.b' })?.charge).toBe(401);
  expect(getShareQueryCost({ ...range, path: 're.a' }, undefined, 4)).toBeNull();
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
  ).toBeNull();
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
  expect(getShareQueryCost({}, undefined, 1025)).toBeNull();
  expect(getShareQueryCost({}, undefined, 1.5 as 1)).toBeNull();
  expect(getShareQueryCost({}, undefined, null)).toBeNull();
});

test('prices pageview fan-out and breakdown grouping dimensions', () => {
  expect(getPageviewShareWorkMultiplier(undefined)).toBe(2);
  expect(getPageviewShareWorkMultiplier('yoy')).toBe(6);
  expect(getPageviewShareWorkMultiplier('invalid')).toBeNull();
  expect(getBreakdownShareWorkMultiplier(['path'])).toBe(2);
  expect(getBreakdownShareWorkMultiplier(Array.from({ length: 20 }, () => 'path'))).toBe(40);
  expect(getBreakdownShareWorkMultiplier([])).toBeNull();
  expect(getShareQueryCost({ startAt: 0, endAt: 1 }, undefined, 40)).toEqual({
    cost: 1,
    charge: 40,
  });
});

test('prices funnel steps, join windows and wildcard predicates', () => {
  const steps = [
    { type: 'path', value: '/start' },
    { type: 'event', value: 'complete' },
  ];

  expect(getFunnelShareWorkMultiplier(steps, 60)).toBe(4);
  expect(getFunnelShareWorkMultiplier(steps, 1440 * 7)).toBe(16);
  expect(getFunnelShareWorkMultiplier([{ ...steps[0], value: '/start*' }, steps[1]], 60)).toBe(8);
  expect(
    getFunnelShareWorkMultiplier(
      [steps[0], { ...steps[1], filters: [{ property: 'plan', operator: 'c', value: 'pro' }] }],
      60,
    ),
  ).toBe(8);
  expect(
    getFunnelShareWorkMultiplier(
      Array.from({ length: 8 }, () => steps[0]),
      525_600,
    ),
  ).toBe(2928);
  expect(getShareQueryCost({ startAt: 0, endAt: 1 }, undefined, 2928)).toBeNull();
  expect(getFunnelShareWorkMultiplier(steps, 0)).toBeNull();
  expect(getFunnelShareWorkMultiplier([], 60)).toBeNull();
});

test('prices journey depth and paged count, result, and skipped rows', () => {
  expect(getJourneyShareWorkMultiplier(2)).toBe(4);
  expect(getJourneyShareWorkMultiplier(7)).toBe(14);
  expect(getJourneyShareWorkMultiplier(8)).toBeNull();
  expect(getJourneyShareWorkMultiplier(2.5)).toBeNull();
  expect(getPagedShareWorkMultiplier(undefined, undefined)).toBe(2);
  expect(getPagedShareWorkMultiplier(3, 20)).toBe(4);
  expect(getPagedShareWorkMultiplier(1, 500)).toBe(26);
  expect(getPagedShareWorkMultiplier(10_000, 500)).toBe(250_001);
  expect(getShareQueryCost({ startAt: 0, endAt: 1 }, undefined, 250_001)).toBeNull();
  expect(getPagedShareWorkMultiplier(0, 20)).toBeNull();
  expect(getPagedShareWorkMultiplier(1, 501)).toBeNull();
});

test('charges validated metric offsets without charging ignored channel paging', () => {
  expect(getMetricShareWorkMultiplier('path', undefined, undefined)).toBe(2);
  expect(getMetricShareWorkMultiplier('path', 20, 10_000)).toBe(22);
  expect(getMetricShareWorkMultiplier('channel', 500, 10_000)).toBe(1);
  expect(getMetricShareWorkMultiplier('path', 500, 10_001)).toBeNull();
});

test('charges event series cardinality and bucket work before querying', () => {
  const startAt = Date.UTC(2025, 0, 1);
  const endAt = Date.UTC(2025, 0, 2);

  expect(getEventSeriesShareWorkMultiplier({ startAt, endAt, unit: 'day' })).toBe(2);
  expect(getEventSeriesShareWorkMultiplier({ startAt, endAt, unit: 'hour', limit: 500 })).toBe(52);
  expect(getEventSeriesShareWorkMultiplier({ startAt, endAt, unit: 'minute', limit: 500 })).toBe(
    52,
  );
  expect(getEventSeriesShareWorkMultiplier({ startAt, endAt, limit: 0 })).toBeNull();
});

test('prices goal scans and each executed values search term', () => {
  expect(getGoalShareWorkMultiplier('/thank-you')).toBe(2);
  expect(getGoalShareWorkMultiplier('/private*')).toBe(4);
  expect(getGoalShareWorkMultiplier(null)).toBeNull();
  expect(getValuesShareWorkMultiplier(undefined)).toBe(1);
  expect(getValuesShareWorkMultiplier('a,b,c')).toBe(3);
  expect(getValuesShareWorkMultiplier('a%2Cb%2Cc%2Cd%2Ce%2Cf')).toBe(5);
  expect(getValuesShareWorkMultiplier('%')).toBeNull();
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

  expect((await reserveShareQueryCost(shareId, 599)).blocked).toBe(false);
  expect((await reserveShareQueryCost(shareId, 2)).blocked).toBe(true);
  expect((await reserveShareQueryCost(shareId, 1)).blocked).toBe(false);
  expect((await reserveShareQueryCost(shareId, 1)).blocked).toBe(true);
});

test('one public-share viewer cannot spend an independent viewer budget or the global reserve', async () => {
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  try {
    const shareId = `viewer-budget-${crypto.randomUUID()}`;
    const viewerRequest = (ip: string) =>
      new Request('https://analytics.example', { headers: { 'x-real-ip': ip } });
    const attacker = viewerRequest('192.0.2.1');
    const ordinary = viewerRequest('198.51.100.1');
    const third = viewerRequest('203.0.113.1');
    const spoofedForwarding = new Request('https://analytics.example', {
      headers: { 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '203.0.113.200' },
    });

    expect((await reserveShareQueryCostForRequest(shareId, 600, attacker)).blocked).toBe(false);
    expect((await reserveShareQueryCostForRequest(shareId, 1, attacker)).blocked).toBe(true);
    expect((await reserveShareQueryCostForRequest(shareId, 1, spoofedForwarding)).blocked).toBe(
      true,
    );
    expect((await reserveShareQueryCostForRequest(shareId, 600, ordinary)).blocked).toBe(false);
    expect((await reserveShareQueryCostForRequest(shareId, 1, third)).blocked).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

test('one viewer cannot consume every low-cost request slot for the share', async () => {
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  try {
    const shareId = `viewer-requests-${crypto.randomUUID()}`;
    const attacker = new Request('https://analytics.example', {
      headers: { 'x-real-ip': '192.0.2.1' },
    });
    const ordinary = new Request('https://analytics.example', {
      headers: { 'x-real-ip': '198.51.100.1' },
    });
    const reservations = await Promise.all(
      Array.from({ length: 61 }, () => reserveShareQueryCostForRequest(shareId, 1, attacker)),
    );

    expect(reservations.filter(result => !result.blocked)).toHaveLength(60);
    expect(reservations.filter(result => result.blocked)).toHaveLength(1);
    expect((await reserveShareQueryCostForRequest(shareId, 1, ordinary)).blocked).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

test('bounds low-cost public-share requests independently of weighted cost', async () => {
  const shareId = `share-request-count-${crypto.randomUUID()}`;
  const reservations = await Promise.all(
    Array.from({ length: 61 }, () => reserveShareQueryCost(shareId, 1)),
  );

  expect(reservations.filter(result => !result.blocked)).toHaveLength(60);
  expect(reservations.filter(result => result.blocked)).toHaveLength(1);
  expect((await reserveShareQueryCost(shareId, 540, 0)).blocked).toBe(false);
  expect((await reserveShareQueryCost(shareId, 1)).blocked).toBe(true);
});

test('preserves a single historical authenticated breakdown but bounds repeated work', async () => {
  const userId = `historical-user-${crypto.randomUUID()}`;
  const range = { startAt: Date.UTC(2006, 0, 1), endAt: Date.UTC(2025, 11, 31) };
  const budget = getAuthenticatedQueryCost(range, undefined, 40);

  expect(budget?.charge).toBeGreaterThan(9000);
  expect(budget?.charge).toBeLessThan(12_000);
  expect(getAuthenticatedQueryCost({ ...range, path: 'eq./public' }, undefined, 40)).not.toBeNull();
  expect(getAuthenticatedQueryCost({ ...range, path: 're.^/private' }, undefined, 40)).toBeNull();
  if (!budget) throw new Error('Expected a bounded historical query cost.');

  const reservations = await Promise.all([
    reserveAuthenticatedQueryCost(userId, budget.charge),
    reserveAuthenticatedQueryCost(userId, budget.charge),
    reserveAuthenticatedQueryCost(userId, budget.charge),
  ]);

  expect(reservations.map(result => result.blocked).sort()).toEqual([false, false, true]);
  expect((await reserveAuthenticatedQueryCost(userId, 1)).blocked).toBe(false);
  expect((await reserveAuthenticatedQueryCost(`${userId}-other`, budget.charge)).blocked).toBe(
    false,
  );
});

test('bounds parallel low-cost authenticated requests independently of cost', async () => {
  const userId = `request-count-${crypto.randomUUID()}`;
  const results = await Promise.all(
    Array.from({ length: 61 }, () => reserveAuthenticatedQueryCost(userId, 1)),
  );

  expect(results.filter(result => !result.blocked)).toHaveLength(60);
  expect(results.filter(result => result.blocked)).toHaveLength(1);
});

test('tenant counters are independent and fail closed when the shared store is unavailable', async () => {
  const firstWebsiteId = crypto.randomUUID();
  const otherWebsiteId = crypto.randomUUID();
  expect((await reserveTenantQueryCost(firstWebsiteId, 40_000, 0)).blocked).toBe(false);
  expect((await reserveTenantQueryCost(firstWebsiteId, 1)).blocked).toBe(true);
  expect((await reserveTenantQueryCost(otherWebsiteId, 1)).blocked).toBe(false);

  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockRejectedValue(new Error('unavailable'));
  redis.enabled = true;

  try {
    expect(await reserveTenantQueryCost(crypto.randomUUID(), 1)).toMatchObject({
      blocked: true,
      unavailable: true,
    });
  } finally {
    redis.enabled = enabled;
    connect.mockRestore();
  }
});

test('rejects a multi-query request larger than the complete window allowance', async () => {
  const shareId = `historical-report-${crypto.randomUUID()}`;
  const budget = getShareQueryCost(
    { startAt: Date.UTC(2006, 0, 1), endAt: Date.UTC(2025, 11, 31) },
    undefined,
    8,
  );

  expect(budget).toBeNull();
  expect((await reserveShareQueryCost(shareId, 1888)).blocked).toBe(true);
  expect((await reserveShareQueryCost(shareId, 600)).blocked).toBe(false);
  expect((await reserveShareQueryCost(shareId, 1)).blocked).toBe(true);
});

test('Redis reservations reject oversized charges before connecting', async () => {
  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockResolvedValue();
  const counters = new Map<string, number>();
  const withAbortSignal = vi.spyOn(redis.client.client, 'withAbortSignal').mockImplementation(
    () =>
      ({
        eval: (_script: string, options: { keys: string[]; arguments: string[] }) => {
          const [cost, , globalCost, requestCount, globalRequests, viewerCost, viewerRequests] =
            options.arguments.map(Number);
          const charges = [cost, requestCount, cost, requestCount];
          const capacities = [globalCost, globalRequests, viewerCost, viewerRequests];
          if (
            options.keys.some(
              (key, index) => (counters.get(key) ?? 0) + charges[index] > capacities[index],
            )
          ) {
            return Promise.resolve(-1);
          }
          options.keys.forEach((key, index) => {
            counters.set(key, (counters.get(key) ?? 0) + charges[index]);
          });
          return Promise.resolve(counters.get(options.keys[0]));
        },
      }) as any,
  );
  redis.enabled = true;

  try {
    const shareId = `redis-historical-report-${crypto.randomUUID()}`;
    expect((await reserveShareQueryCost(shareId, 1888)).blocked).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect((await reserveShareQueryCost(shareId, 599)).blocked).toBe(false);
    expect((await reserveShareQueryCost(shareId, 2)).blocked).toBe(true);
    expect((await reserveShareQueryCost(shareId, 1)).blocked).toBe(false);
    expect((await reserveShareQueryCost(shareId, 1888)).blocked).toBe(true);
  } finally {
    redis.enabled = enabled;
    connect.mockRestore();
    withAbortSignal.mockRestore();
  }
});

test('Redis atomically bounds authenticated cost and request count', async () => {
  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockResolvedValue();
  const counters = new Map<string, number>();
  const withAbortSignal = vi.spyOn(redis.client.client, 'withAbortSignal').mockImplementation(
    () =>
      ({
        eval: (_script: string, options: { keys: string[]; arguments: string[] }) => {
          const [costKey, requestKey] = options.keys;
          const [cost, , requestCount, maxCost, maxRequests] = options.arguments.map(Number);
          const currentCost = counters.get(costKey) ?? 0;
          const currentRequests = counters.get(requestKey) ?? 0;

          if (currentCost + cost > maxCost || currentRequests + requestCount > maxRequests) {
            return Promise.resolve(-1);
          }

          counters.set(costKey, currentCost + cost);
          counters.set(requestKey, currentRequests + requestCount);
          return Promise.resolve(currentCost + cost);
        },
      }) as any,
  );
  redis.enabled = true;

  try {
    const userId = `redis-auth-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 61 }, () => reserveAuthenticatedQueryCost(userId, 1)),
    );
    expect(results.filter(result => !result.blocked)).toHaveLength(60);
    expect(results.filter(result => result.blocked)).toHaveLength(1);
    expect((await reserveAuthenticatedQueryCost(userId, 19_940, 0)).blocked).toBe(false);
    expect((await reserveAuthenticatedQueryCost(userId, 1, 0)).blocked).toBe(true);
  } finally {
    redis.enabled = enabled;
    connect.mockRestore();
    withAbortSignal.mockRestore();
  }
});

test('Redis atomically bounds public-share cost and request count', async () => {
  const enabled = redis.enabled;
  const connect = vi.spyOn(redis.client, 'connect').mockResolvedValue();
  const counters = new Map<string, number>();
  const withAbortSignal = vi.spyOn(redis.client.client, 'withAbortSignal').mockImplementation(
    () =>
      ({
        eval: (_script: string, options: { keys: string[]; arguments: string[] }) => {
          const [cost, , maxCost, requestCount, maxRequests, maxViewerCost, maxViewerRequests] =
            options.arguments.map(Number);
          const charges = [cost, requestCount, cost, requestCount];
          const capacities = [maxCost, maxRequests, maxViewerCost, maxViewerRequests];

          if (
            options.keys.some(
              (key, index) => (counters.get(key) ?? 0) + charges[index] > capacities[index],
            )
          ) {
            return Promise.resolve(-1);
          }

          options.keys.forEach((key, index) => {
            counters.set(key, (counters.get(key) ?? 0) + charges[index]);
          });
          return Promise.resolve(counters.get(options.keys[0]));
        },
      }) as any,
  );
  redis.enabled = true;

  try {
    const shareId = `redis-share-${crypto.randomUUID()}`;
    const reservations = await Promise.all(
      Array.from({ length: 61 }, () => reserveShareQueryCost(shareId, 1)),
    );
    expect(reservations.filter(result => !result.blocked)).toHaveLength(60);
    expect(reservations.filter(result => result.blocked)).toHaveLength(1);
    expect((await reserveShareQueryCost(shareId, 540, 0)).blocked).toBe(false);

    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
    const firstViewer = new Request('https://analytics.example', {
      headers: { 'x-real-ip': '192.0.2.1' },
    });
    const secondViewer = new Request('https://analytics.example', {
      headers: { 'x-real-ip': '198.51.100.1' },
    });
    const thirdViewer = new Request('https://analytics.example', {
      headers: { 'x-real-ip': '203.0.113.1' },
    });
    const fairShare = `redis-viewer-${crypto.randomUUID()}`;
    expect((await reserveShareQueryCostForRequest(fairShare, 600, firstViewer)).blocked).toBe(
      false,
    );
    expect((await reserveShareQueryCostForRequest(fairShare, 1, firstViewer)).blocked).toBe(true);
    expect((await reserveShareQueryCostForRequest(fairShare, 600, secondViewer)).blocked).toBe(
      false,
    );
    expect((await reserveShareQueryCostForRequest(fairShare, 1, thirdViewer)).blocked).toBe(true);
    expect(counters.size).toBe(10);
  } finally {
    vi.unstubAllEnvs();
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
