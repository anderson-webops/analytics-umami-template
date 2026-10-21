import { beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { checkAuth } from '@/lib/auth';
import { fetchAccount, fetchWebsite } from '@/lib/load';
import { canViewWebsite } from '@/permissions';
import { getWebsite, getWebsiteSegment } from '@/queries/prisma';
import { OPERATORS } from './constants';
import { reserveAuthenticatedQueryLease } from './query-concurrency';
import { getBoundedCompareDate, getQueryFilters, parseRequest } from './request';
import { readRequestBodyBytes } from './request-body';
import {
  fieldsParam,
  pagingParams,
  reportResultSchema,
  searchParams,
  withDateRange,
} from './schema';
import {
  getPagedShareWorkMultiplier,
  reserveAuthenticatedQueryCost,
  reserveShareQueryCost as reserveShareQueryCostForRequest,
  reserveTenantQueryCost,
} from './share-query-budget';

const reserveShareQueryCost = (shareId: string, cost: number, requestCount: 0 | 1 = 1) =>
  reserveShareQueryCostForRequest(
    shareId,
    cost,
    new Request('https://analytics.example'),
    requestCount,
  );

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
  delete process.env.DATABASE_REPLICA_URL;
});

vi.mock('@/lib/auth', () => ({
  checkAuth: vi.fn(),
}));

vi.mock('@/lib/load', () => ({
  fetchAccount: vi.fn(),
  fetchWebsite: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  getWebsite: vi.fn(),
  getWebsiteSegment: vi.fn(),
}));

vi.mock('@/permissions', () => ({
  canViewWebsite: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));

const checkAuthMock = vi.mocked(checkAuth);
const fetchAccountMock = vi.mocked(fetchAccount);
const fetchWebsiteMock = vi.mocked(fetchWebsite);
const getWebsiteMock = vi.mocked(getWebsite);
const getWebsiteSegmentMock = vi.mocked(getWebsiteSegment);
const canViewWebsiteMock = vi.mocked(canViewWebsite);

beforeEach(() => {
  checkAuthMock.mockReset();
  fetchAccountMock.mockReset();
  fetchWebsiteMock.mockReset();
  getWebsiteMock.mockReset();
  getWebsiteSegmentMock.mockReset();
  canViewWebsiteMock.mockReset();
  canViewWebsiteMock.mockResolvedValue(true);
  fetchWebsiteMock.mockResolvedValue({ id: 'website-1' } as any);
  getWebsiteMock.mockImplementation(
    async websiteId => ({ id: websiteId, userId: websiteId, teamId: null }) as any,
  );
});

test.each([21, 10_000])('rejects %i decoded items before recursive validation', async count => {
  const schema = z.array(z.number()).max(20);
  const parse = vi.spyOn(schema, 'safeParse');
  const request = new Request('https://analytics.example/api/batch', {
    method: 'POST',
    body: JSON.stringify(Array(count).fill(null)),
  });

  const result = await parseRequest(request, schema, {
    skipAuth: true,
    bodyPreflight: body => Array.isArray(body) && body.length <= 20,
  });
  const response = result.error?.();

  expect(parse).not.toHaveBeenCalled();
  expect(response?.status).toBe(400);
  expect((await response?.text())?.length).toBeLessThan(200);
});

test('preserves valid bodies and bounds detailed validation errors', async () => {
  const schema = z.array(z.number()).max(200);
  const request = (body: unknown) =>
    new Request('https://analytics.example/api/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  expect(
    (
      await parseRequest(request(Array(20).fill(1)), schema, {
        skipAuth: true,
        bodyPreflight: body => Array.isArray(body) && body.length <= 20,
      })
    ).error,
  ).toBeUndefined();

  const invalid = await parseRequest(request(Array(100).fill(null)), schema, { skipAuth: true });
  const response = invalid.error?.();

  expect(response?.status).toBe(400);
  expect((await response?.text())?.length).toBeLessThan(200);
});

test('bounds a single validation issue that names many unexpected input keys', async () => {
  const body = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [`unexpected_${index}`, true]),
  );
  const result = await parseRequest(
    new Request('https://analytics.example/api/record', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    z.object({ type: z.literal('heatmap') }).strict(),
    { skipAuth: true },
  );
  const response = result.error?.();

  expect(response?.status).toBe(400);
  expect((await response?.text())?.length).toBeLessThan(200);
});

test.each(['prev', 'yoy'] as const)(
  'bounds %s comparison to the website reset even when the requested range is newer',
  async compare => {
    const resetAt = new Date('2026-09-01T12:00:00.000Z');
    fetchWebsiteMock.mockResolvedValue({ id: 'website-1', resetAt } as any);

    const comparison = await getBoundedCompareDate(
      'website-1',
      compare,
      new Date('2026-09-02T00:00:00.000Z'),
      new Date('2026-09-03T00:00:00.000Z'),
    );

    expect(comparison.startDate).toEqual(resetAt);
    expect(fetchWebsiteMock).toHaveBeenCalledWith('website-1');
  },
);

test('bounds a year-over-year comparison to the cloud subscription history limit', async () => {
  const previousCloudMode = process.env.CLOUD_MODE;
  process.env.CLOUD_MODE = '1';
  try {
    fetchWebsiteMock.mockResolvedValue({ id: 'website-1', userId: 'account-1' } as any);
    fetchAccountMock.mockResolvedValue({ hasSubscription: false } as any);

    const comparison = await getBoundedCompareDate('website-1', 'yoy', new Date(), new Date());

    expect(comparison.startDate.getTime()).toBeGreaterThan(comparison.endDate.getTime());
    expect(fetchAccountMock).toHaveBeenCalledWith('account-1');
  } finally {
    if (previousCloudMode === undefined) {
      delete process.env.CLOUD_MODE;
    } else {
      process.env.CLOUD_MODE = previousCloudMode;
    }
  }
});

test('rejects direct query filters when a public share disables filters', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      websiteId: '00000000-0000-4000-8000-000000000001',
      parameters: { allowFilter: false },
    },
  } as any);

  const result = await parseRequest(
    new Request('https://analytics.example/api/test?startAt=1&endAt=2&country=US'),
  );
  const response = result.error?.();

  expect(response?.status).toBe(403);
  await expect(response?.json()).resolves.toMatchObject({
    error: { code: 'share-filters-disabled' },
  });
});

test.each(['epf0=1.eq.plan.pro', 'spf0=1.eq.plan.pro', 'search=plan', 'minDuration=30'])(
  'rejects %s for a signed-in public-share holder',
  async filter => {
    checkAuthMock.mockResolvedValue({
      user: { id: 'unrelated-user', role: 'user' },
      shareToken: {
        websiteId: '00000000-0000-4000-8000-000000000001',
        parameters: { allowFilter: false },
      },
    } as any);

    const schema = z.object({
      startAt: z.coerce.number(),
      endAt: z.coerce.number(),
      search: z.string().optional(),
      minDuration: z.coerce.number().optional(),
    });
    const result = await parseRequest(
      new Request(`https://analytics.example/api/test?startAt=1&endAt=2&${filter}`),
      schema,
    );

    expect(result.error?.().status).toBe(403);
  },
);

test('allows date and paging parameters when a public share disables filters', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      websiteId: '00000000-0000-4000-8000-000000000001',
      parameters: { allowFilter: false },
    },
  } as any);

  const result = await parseRequest(
    new Request('https://analytics.example/api/test?startAt=1&endAt=2&page=1'),
  );

  expect(result.error).toBeUndefined();
});

test('an empty expanded-view search is not a filter', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      websiteId: '00000000-0000-4000-8000-000000000001',
      parameters: { allowFilter: false },
    },
  } as any);

  const schema = withDateRange({ type: fieldsParam, ...searchParams });
  const base = `https://analytics.example/api/websites/website-1/metrics/expanded?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 2)}&type=referrer`;
  expect((await parseRequest(new Request(`${base}&search=`), schema)).error).toBeUndefined();
  expect((await parseRequest(new Request(`${base}&search=private`), schema)).error?.().status).toBe(
    403,
  );
});

test('allows only bounded path and event selector search when explicitly enabled', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      websiteId: '00000000-0000-4000-8000-000000000001',
      parameters: { allowFilter: false, journeys: true },
    },
  } as any);

  const schema = withDateRange({ type: fieldsParam, ...searchParams });
  const base = `https://analytics.example/api/websites/website-1/values?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 2)}`;
  const parse = (query: string, allowShareSearch = false) =>
    parseRequest(new Request(`${base}&${query}`), schema, { allowShareSearch });

  expect((await parse('type=path&search=home')).error?.().status).toBe(403);
  expect((await parse('type=path&search=home', true)).error).toBeUndefined();
  expect((await parse('type=event&search=signup', true)).error).toBeUndefined();
  expect((await parse('type=distinctId&search=visitor', true)).error?.().status).toBe(403);
  expect((await parse('type=path&search=home&country1=US', true)).error?.().status).toBe(403);
  expect((await parse(`type=path&search=${'a'.repeat(201)}`, true)).error?.().status).toBe(400);
});

test('bounds public-share property fan-out while preserving ordinary filtered views', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      shareId: 'fanout-share',
      websiteId: 'website-1',
      parameters: { allowFilter: true },
    },
  } as any);

  const schema = z.object({ startAt: z.coerce.number(), endAt: z.coerce.number() });
  const startAt = Date.UTC(2025, 0, 1);
  const endAt = Date.UTC(2025, 0, 31);
  const propertyFilters = count =>
    Array.from({ length: count }, (_, index) => `pf_property${index}=1.eq.value`).join('&');
  const request = count =>
    new Request(
      `https://analytics.example/api/websites/website-1/event-data-pivot?startAt=${startAt}&endAt=${endAt}&${propertyFilters(count)}`,
    );

  const ordinary = await parseRequest(request(8), schema);
  expect(ordinary.error).toBeUndefined();

  const amplified = await parseRequest(request(100), schema);
  expect(amplified.error?.().status).toBe(400);
});

test('caps public-share count work without changing authenticated pagination', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId: `count-cap-${crypto.randomUUID()}`, websiteId: 'website-1' },
  } as any);

  const schema = withDateRange(pagingParams);
  const options = {
    capShareCount: true,
    shareQueryWorkMultiplier: (query: Record<string, any>) =>
      getPagedShareWorkMultiplier(query.page, query.pageSize),
  };
  const request = (pagination = '') =>
    new Request(
      `https://analytics.example/api/websites/website-1/sessions?startAt=0&endAt=1${pagination}`,
    );

  expect((await parseRequest(request(), schema, options)).query.maxResults).toBe(10_000);
  expect(
    (await parseRequest(request('&page=2&pageSize=20&maxResults=100'), schema, options)).query
      .maxResults,
  ).toBe(100);
  expect(
    (await parseRequest(request('&page=10000&pageSize=500'), schema, options)).error?.().status,
  ).toBe(400);
  expect(
    (await parseRequest(request('&page=501&pageSize=20'), schema, options)).error?.().status,
  ).toBe(400);
  expect(
    (await parseRequest(request('&page=2&pageSize=20&maxResults=10'), schema, options)).error?.()
      .status,
  ).toBe(400);

  checkAuthMock.mockResolvedValue({ user: { id: `count-control-${crypto.randomUUID()}` } } as any);
  expect((await parseRequest(request(), schema, options)).query.maxResults).toBeUndefined();
  expect(
    (await parseRequest(request('&page=501&pageSize=20'), schema, options)).error,
  ).toBeUndefined();
});

test('bounds realtime shares without a caller-supplied date range', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      shareId: `realtime-share-${crypto.randomUUID()}`,
      websiteId: 'website-1',
      parameters: { allowFilter: true, realtime: true },
    },
  } as any);

  const schema = z.object({});
  const propertyFilters = count =>
    Array.from({ length: count }, (_, index) => `pf_property${index}=1.eq.value`).join('&');
  const request = count =>
    new Request(`https://analytics.example/api/realtime/website-1?${propertyFilters(count)}`);
  const options = { budgetShareQuery: true };

  expect((await parseRequest(request(17), schema, options)).error?.().status).toBe(400);

  for (let index = 0; index < 9; index += 1) {
    expect((await parseRequest(request(16), schema, options)).error).toBeUndefined();
  }

  expect((await parseRequest(request(16), schema, options)).error?.().status).toBe(429);
});

test('budgets parameterless aggregate shares without pricing ignored URL dates', async () => {
  const shareId = `parameterless-share-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId, websiteId: 'website-1' },
  } as any);

  expect((await reserveShareQueryCost(shareId, 600)).blocked).toBe(false);

  const request = () =>
    new Request('https://analytics.example/api/websites/website-1/active?startAt=2&endAt=1');
  const schema = z.object({});

  expect((await parseRequest(request(), schema)).error).toBeUndefined();

  const budgeted = await parseRequest(request(), schema, { budgetShareQuery: true });
  const response = budgeted.error?.();

  expect(response?.status).toBe(429);
  expect(response?.headers.get('Retry-After')).toBe('60');

  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  expect((await parseRequest(request(), schema, { budgetShareQuery: true })).error).toBeUndefined();
});

test('prices public shares from validated route-specific work without charging signed-in owners', async () => {
  const shareId = `route-work-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: 'website-1' } } as any);
  expect((await reserveShareQueryCost(shareId, 596)).blocked).toBe(false);

  const schema = z.object({
    startAt: z.coerce.number(),
    endAt: z.coerce.number(),
    work: z.coerce.number(),
  });
  const request = () => new Request('https://analytics.example/api/test?startAt=1&endAt=2&work=5');
  const options = { shareQueryWorkMultiplier: query => query.work };

  expect((await parseRequest(request(), schema, options)).error?.().status).toBe(429);

  checkAuthMock.mockResolvedValue({ user: { id: 'website-owner' } } as any);
  expect((await parseRequest(request(), schema, options)).error).toBeUndefined();
});

test('limits public regex scans while preserving ordinary shared filters', async () => {
  const shareId = `regex-share-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: 'website-1' } } as any);
  const schema = z.object({
    startAt: z.coerce.number(),
    endAt: z.coerce.number(),
    path: z.string(),
  });
  const request = path =>
    new Request(
      `https://analytics.example/api/test?startAt=0&endAt=1&path=${encodeURIComponent(path)}`,
    );

  expect((await parseRequest(request('re.^/private'), schema)).error).toBeUndefined();
  expect((await parseRequest(request('nre.^/private'), schema)).error).toBeUndefined();
  expect((await parseRequest(request('re.^/private'), schema)).error?.().status).toBe(429);

  const ordinaryShareId = `ordinary-share-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId: ordinaryShareId, websiteId: 'website-1' },
  } as any);
  expect((await parseRequest(request('eq.re.literal'), schema)).error).toBeUndefined();
});

test('bounds wide filtered shares but preserves unfiltered historical views', async () => {
  const shareId = `historical-share-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId, websiteId: 'website-1' },
  } as any);

  const schema = z.object({ startAt: z.coerce.number(), endAt: z.coerce.number() });
  const startAt = Date.UTC(2006, 0, 1);
  const endAt = Date.UTC(2025, 11, 31);
  const base = `https://analytics.example/api/test?startAt=${startAt}&endAt=${endAt}`;

  for (let index = 0; index < 2; index += 1) {
    expect((await parseRequest(new Request(base), schema)).error).toBeUndefined();
  }
  expect((await parseRequest(new Request(base), schema)).error?.().status).toBe(429);
  expect(
    (await parseRequest(new Request(`${base}&pf_plan=1.eq.pro`), schema)).error?.().status,
  ).toBe(400);
});

test('does not let unrelated endpoints consume a public analytics quota', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId: 'unrelated-endpoint-share', websiteId: 'website-1' },
  } as any);

  const startAt = Date.UTC(2025, 0, 1);
  const endAt = Date.UTC(2025, 11, 31);
  const properties = Array.from({ length: 12 }, (_, index) => `pf_plan${index}=1.eq.pro`).join('&');
  const query = `startAt=${startAt}&endAt=${endAt}&country=US&${properties}`;

  expect(
    (await parseRequest(new Request(`https://analytics.example/api/me?${query}`))).error,
  ).toBeUndefined();
  expect(
    (
      await parseRequest(
        new Request(`https://analytics.example/api/websites/website-1/event-data-pivot?${query}`),
        z.object({ startAt: z.coerce.number(), endAt: z.coerce.number() }),
      )
    ).error,
  ).toBeUndefined();
});

test('uses report body dates when a POST also has unrelated URL dates', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId: 'report-date-share', websiteId: 'website-1' },
  } as any);

  const result = await parseRequest(
    new Request('https://analytics.example/compat/api/reports/funnel?startAt=0&endAt=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parameters: {
          startDate: '2006-01-01',
          endDate: '2025-12-31',
          steps: [{ filters: [{ property: 'plan', value: 'pro' }] }],
        },
      }),
    }),
    z.object({
      parameters: z.object({
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
        steps: z.array(z.any()),
      }),
    }),
  );

  expect(result.error?.().status).toBe(400);
});

test('rejects nested funnel filters when a public share disables filtering', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      shareId: 'disabled-funnel-share',
      websiteId: 'website-1',
      parameters: { allowFilter: false },
    },
  } as any);

  const schema = z.object({ steps: z.string().transform(value => JSON.parse(value)) });
  const steps = encodeURIComponent(
    JSON.stringify([{ filters: [{ property: 'plan', value: 'pro' }] }]),
  );
  const result = await parseRequest(
    new Request(`https://analytics.example/api/test?steps=${steps}`),
    schema,
  );

  expect(result.error?.().status).toBe(403);
});

test('rejects report filter objects when a public share disables filters', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      websiteId: '00000000-0000-4000-8000-000000000001',
      parameters: { allowFilter: false },
    },
  } as any);

  const result = await parseRequest(
    new Request('https://analytics.example/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filters: { country: 'US' } }),
    }),
  );

  expect(result.error?.().status).toBe(403);
});

test('charges the signed-in user even when a valid share credential is also present', async () => {
  const userId = `mixed-credential-user-${crypto.randomUUID()}`;
  const shareId = `mixed-credential-share-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({
    user: { id: userId },
    shareToken: { shareId, websiteId: 'website-1' },
  } as any);
  expect((await reserveAuthenticatedQueryCost(userId, 20_000, 0)).blocked).toBe(false);

  const result = await parseRequest(
    new Request(
      `https://analytics.example/api/websites/website-1/stats?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 31)}`,
    ),
    z.object({ startAt: z.coerce.number().int(), endAt: z.coerce.number().int() }),
  );

  expect(result.error?.().status).toBe(429);
});

test('rejects excess authenticated in-flight work before the report reaches its query', async () => {
  const userId = crypto.randomUUID();
  const websiteId = crypto.randomUUID();
  const leases = await Promise.all(
    Array.from({ length: 8 }, () => reserveAuthenticatedQueryLease(userId, websiteId, 1)),
  );
  checkAuthMock.mockResolvedValue({ user: { id: userId } } as any);

  try {
    const result = await parseRequest(
      new Request(
        `https://analytics.example/api/websites/${websiteId}/stats?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 2)}`,
      ),
      z.object({ startAt: z.coerce.number(), endAt: z.coerce.number() }),
    );

    expect(result.error?.().status).toBe(429);
  } finally {
    for (const lease of leases) {
      if ('release' in lease) await lease.release();
    }
  }
});

test('a tenant budget bounds aggregate work across different authorized viewers', async () => {
  const websiteId = '00000000-0000-4000-8000-000000000001';
  const otherWebsiteId = '00000000-0000-4000-8000-000000000002';
  expect((await reserveTenantQueryCost(`user:${websiteId}`, 40_000, 0)).blocked).toBe(false);
  const range = `startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 31)}`;
  const schema = z.object({ startAt: z.coerce.number().int(), endAt: z.coerce.number().int() });

  checkAuthMock.mockResolvedValueOnce({ user: { id: crypto.randomUUID() } } as any);
  const blocked = await parseRequest(
    new Request(`https://analytics.example/api/websites/${websiteId}/stats?${range}`),
    schema,
  );
  expect(blocked.error?.().status).toBe(429);

  checkAuthMock.mockResolvedValueOnce({ user: { id: crypto.randomUUID() } } as any);
  const independent = await parseRequest(
    new Request(`https://analytics.example/api/websites/${otherWebsiteId}/stats?${range}`),
    schema,
  );
  expect(independent.error).toBeUndefined();
});

test('does not let an unauthorized caller drain another website budget', async () => {
  const websiteId = '00000000-0000-4000-8000-000000000003';
  canViewWebsiteMock.mockResolvedValue(false);
  checkAuthMock.mockResolvedValue({ user: { id: crypto.randomUUID() } } as any);
  const schema = z.object({ startAt: z.coerce.number().int(), endAt: z.coerce.number().int() });
  const request = new Request(
    `https://analytics.example/api/websites/${websiteId}/stats?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 31)}`,
  );

  expect((await parseRequest(request, schema)).error).toBeUndefined();
  expect((await reserveTenantQueryCost(`user:${websiteId}`, 40_000, 0)).blocked).toBe(false);
});

test('charges compatibility POST reports to the authorized website budget', async () => {
  const websiteId = '00000000-0000-4000-8000-000000000004';
  checkAuthMock.mockResolvedValue({ user: { id: crypto.randomUUID() } } as any);
  expect((await reserveTenantQueryCost(`user:${websiteId}`, 40_000, 0)).blocked).toBe(false);

  const result = await parseRequest(
    new Request('https://analytics.example/compat/api/reports/goal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        websiteId,
        type: 'goal',
        parameters: {
          startDate: '2025-01-01',
          endDate: '2025-01-31',
          type: 'event',
          value: 'signup',
        },
        filters: {},
      }),
    }),
    reportResultSchema,
  );

  expect(result.error?.().status).toBe(429);
});

test('prices a stored historical cohort before admitting a short-range query', async () => {
  const websiteId = crypto.randomUUID();
  const cohortId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const startAt = Date.UTC(2025, 0, 1);
  const endAt = Date.UTC(2025, 0, 2);
  getWebsiteSegmentMock.mockResolvedValue({
    name: 'Historical visitors',
    type: 'cohort',
    parameters: {
      filters: [],
      dateRange: `range:${Date.UTC(2006, 0, 1)}:${Date.UTC(2025, 11, 31)}`,
      action: { type: 'event', value: 'signup' },
    },
  } as any);
  checkAuthMock.mockResolvedValue({ user: { id: userId } } as any);

  const result = await parseRequest(
    new Request(
      `https://analytics.example/api/websites/${websiteId}/stats?startAt=${startAt}&endAt=${endAt}&cohort=${cohortId}`,
    ),
    withDateRange({ cohort: z.uuid().optional() }),
  );

  expect(result.error?.().status).toBe(400);
  expect(getWebsiteSegmentMock).toHaveBeenCalledWith(websiteId, cohortId);
  expect((await reserveAuthenticatedQueryCost(userId, 20_000, 0)).blocked).toBe(false);
});

test('rejects a saved cohort beyond the verified identity-filter limit at admission', async () => {
  const originalClickHouseUrl = process.env.CLICKHOUSE_URL;
  process.env.CLICKHOUSE_URL = 'http://127.0.0.1:8123/synthetic';
  const websiteId = crypto.randomUUID();
  const cohortId = crypto.randomUUID();
  const startAt = Date.UTC(2025, 0, 1);
  const endAt = startAt + 86_400_000;
  getWebsiteSegmentMock.mockResolvedValue({
    name: 'Many identities',
    type: 'cohort',
    parameters: {
      filters: Array.from({ length: 8 }, () => ({
        name: 'distinctId',
        operator: OPERATORS.equals,
        value: 'synthetic-user',
      })),
      dateRange: `range:${startAt}:${endAt}`,
      action: { type: 'distinctId', value: 'synthetic-user' },
    },
  } as any);
  checkAuthMock.mockResolvedValue({ user: { id: crypto.randomUUID() } } as any);

  try {
    const result = await parseRequest(
      new Request(
        `https://analytics.example/api/websites/${websiteId}/stats?startAt=${startAt}&endAt=${endAt}&cohort=${cohortId}`,
      ),
      withDateRange({ cohort: z.uuid().optional() }),
    );

    expect(result.error?.().status).toBe(400);
  } finally {
    if (originalClickHouseUrl === undefined) {
      delete process.env.CLICKHOUSE_URL;
    } else {
      process.env.CLICKHOUSE_URL = originalClickHouseUrl;
    }
  }
});

test('uses the cohort snapshot priced at admission when building SQL filters', async () => {
  const websiteId = crypto.randomUUID();
  const cohortId = crypto.randomUUID();
  const cohortStartAt = Date.UTC(2025, 0, 1);
  const cohortEndAt = Date.UTC(2025, 2, 1);
  getWebsiteSegmentMock.mockResolvedValueOnce({
    name: 'Recent visitors',
    type: 'cohort',
    parameters: {
      filters: [],
      dateRange: `range:${cohortStartAt}:${cohortEndAt}`,
      action: { type: 'event', value: 'signup' },
    },
  } as any);
  checkAuthMock.mockResolvedValue({ user: { id: crypto.randomUUID() } } as any);

  const result = await parseRequest(
    new Request(
      `https://analytics.example/api/websites/${websiteId}/stats?startAt=${cohortStartAt}&endAt=${cohortStartAt + 86_400_000}&cohort=${cohortId}`,
    ),
    withDateRange({ cohort: z.uuid().optional() }),
  );

  expect(result.error).toBeUndefined();
  getWebsiteSegmentMock.mockResolvedValue(null);
  const filters = await getQueryFilters({ ...result.query }, websiteId);
  expect(+Reflect.get(filters, 'cohort_startDate')).toBe(cohortStartAt);
  expect(+Reflect.get(filters, 'cohort_endDate')).toBe(cohortEndAt);
  expect(getWebsiteSegmentMock).toHaveBeenCalledTimes(1);
});

test('rejects untrusted SQL filter metadata in compatibility report requests', async () => {
  checkAuthMock.mockResolvedValue({ user: { id: 'user-1', role: 'user' } } as any);

  const result = await parseRequest(
    new Request('https://analytics.example/compat/api/reports/goal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        websiteId: '11111111-1111-4111-8111-111111111111',
        type: 'goal',
        parameters: {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          type: 'event',
          value: 'signup',
        },
        filters: {
          path1: { name: 'path', operator: 'eq', value: '/', prefix: 'OR TRUE OR ' },
        },
      }),
    }),
    reportResultSchema,
  );

  expect(result.error?.().status).toBe(400);
});

test.each([
  ['user', '/compat/api/reports/goal'],
  ['user', '/api/reports/goal'],
  ['share', '/compat/api/reports/goal'],
  ['share', '/api/reports/goal'],
] as const)(
  'bounds compatibility POST filter fan-out for a %s on %s',
  async (principal, pathname) => {
    const websiteId = '11111111-1111-4111-8111-111111111111';
    checkAuthMock.mockResolvedValue(
      principal === 'share'
        ? ({ shareToken: { shareId: crypto.randomUUID(), websiteId } } as any)
        : ({ user: { id: crypto.randomUUID(), role: 'user' } } as any),
    );

    const request = (filters: Record<string, string>) =>
      new Request(`https://analytics.example${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          websiteId,
          type: 'goal',
          parameters: {
            startDate: '2024-01-01',
            endDate: '2024-01-31',
            type: 'event',
            value: 'signup',
          },
          filters,
        }),
      });

    const filtersWithCount = (filterCount: number) =>
      Object.fromEntries(
        Array.from({ length: filterCount }, (_, filterIndex) => [`country${filterIndex}`, 'eq.US']),
      );
    const schemaParse = vi.spyOn(reportResultSchema, 'safeParse');

    try {
      const oversized = await parseRequest(request(filtersWithCount(1000)), reportResultSchema);

      expect(oversized.error?.().status).toBe(400);
      expect(schemaParse).not.toHaveBeenCalled();

      const oversizedKey = await parseRequest(
        request({ [`country${'0'.repeat(122)}`]: 'eq.US' }),
        reportResultSchema,
      );
      const oversizedValue = await parseRequest(
        request({ country: 'a'.repeat(501) }),
        reportResultSchema,
      );

      expect(oversizedKey.error?.().status).toBe(400);
      expect(oversizedValue.error?.().status).toBe(400);
      expect(schemaParse).not.toHaveBeenCalled();

      const amplified = await parseRequest(request(filtersWithCount(25)), reportResultSchema);

      expect(amplified.error?.().status).toBe(400);
      expect(schemaParse).toHaveBeenCalledTimes(1);

      const accepted = await parseRequest(request({ country: 'eq.US' }), reportResultSchema);

      expect(accepted.error).toBeUndefined();
      expect((await getQueryFilters(accepted.body.filters)).country).toBe('eq.US');
    } finally {
      schemaParse.mockRestore();
    }
  },
);

test('rejects an oversized request URL before authentication', async () => {
  const result = await parseRequest(
    new Request(`https://analytics.example/api/test?search=${'a'.repeat(17 * 1024)}`),
  );

  expect(result.error?.().status).toBe(400);
  expect(checkAuthMock).not.toHaveBeenCalled();
});

test('rejects excessive query parameter fan-out before authentication', async () => {
  const query = Array.from({ length: 201 }, (_, index) => `field${index}=value`).join('&');
  const result = await parseRequest(new Request(`https://analytics.example/api/test?${query}`));

  expect(result.error?.().status).toBe(400);
  expect(checkAuthMock).not.toHaveBeenCalled();
});

test('validates HEAD query parameters using the GET schema path', async () => {
  const schema = z.object({ page: z.coerce.number().int().positive() });
  const result = await parseRequest(
    new Request('https://analytics.example/api/test?page=2', { method: 'HEAD' }),
    schema,
    { skipAuth: true },
  );

  expect(result.error).toBeUndefined();
  expect(result.query).toEqual({ page: 2 });
});

test('cancels a chunked request as soon as its actual body exceeds the byte limit', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(10 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request('https://analytics.example/api/test', {
    method: 'POST',
    headers: { 'content-length': '1' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  await expect(readRequestBodyBytes(request, 16 * 1024)).rejects.toThrow(
    'Request body exceeds the configured size limit',
  );
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(2);
});

test("combines a saved segment's session property filters with active filters", async () => {
  getWebsiteSegmentMock.mockResolvedValue({
    type: 'segment',
    name: 'Paid users',
    parameters: {
      filters: [],
      sessionPropertyFilters: [{ propertyName: 'plan', dataType: 1, operator: 'eq', value: 'pro' }],
    },
  } as any);

  const filters = await getQueryFilters(
    {
      startAt: String(+new Date('2026-09-01T00:00:00.000Z')),
      endAt: String(+new Date('2026-09-02T00:00:00.000Z')),
      segment: 'segment-1',
      spf0: '1.eq.country.US',
    },
    'website-1',
  );

  expect(filters.sessionPropertyFilters).toEqual([
    { propertyName: 'country', dataType: 1, operator: 'eq', value: 'US' },
    { propertyName: 'plan', dataType: 1, operator: 'eq', value: 'pro' },
  ]);
});

test.each(['metric', 'window', 'metric0', '__proto__'])(
  'rejects a stored segment filter named %s before applying it',
  async name => {
    getWebsiteSegmentMock.mockResolvedValue({
      type: 'segment',
      name: 'Unsafe filter',
      parameters: { filters: [{ name, operator: 'eq', value: 'lcp' }] },
    } as any);

    await expect(
      getQueryFilters(
        { startAt: '1788220800000', endAt: '1788307200000', segment: 'segment-1' },
        'website-1',
      ),
    ).rejects.toThrow('INVALID_SAVED_SEGMENT');
  },
);

test('applies an allowed saved segment filter without changing request controls', async () => {
  getWebsiteSegmentMock.mockResolvedValue({
    type: 'segment',
    name: 'US visitors',
    parameters: { filters: [{ name: 'country', operator: 'eq', value: 'US' }] },
  } as any);

  const filters = await getQueryFilters(
    { startAt: '1788220800000', endAt: '1788307200000', segment: 'segment-1' },
    'website-1',
  );

  expect(filters.country).toBe('eq.US');
  expect(filters).not.toHaveProperty('metric');
  expect(filters).not.toHaveProperty('window');
});

test('rejects an expensive saved segment before applying its stored regex filters', async () => {
  getWebsiteSegmentMock.mockResolvedValue({
    type: 'segment',
    name: 'Expensive segment',
    parameters: {
      filters: Array.from({ length: 3 }, () => ({
        name: 'path',
        operator: 're',
        value: '^/private',
      })),
    },
  } as any);

  await expect(
    getQueryFilters(
      { startAt: '1788220800000', endAt: '1788307200000', segment: 'segment-1' },
      'website-1',
    ),
  ).rejects.toThrow('INVALID_SAVED_SEGMENT');
});

test('preserves a schema-valid saved segment with ordinary stored filters', async () => {
  getWebsiteSegmentMock.mockResolvedValue({
    type: 'segment',
    name: 'Ordinary segment',
    parameters: {
      filters: Array.from({ length: 50 }, () => ({
        name: 'country',
        operator: 'eq',
        value: 'US',
      })),
      sessionPropertyFilters: Array.from({ length: 50 }, () => ({
        propertyName: 'plan',
        dataType: 1,
        operator: 'eq',
        value: 'pro',
      })),
    },
  } as any);

  const filters = await getQueryFilters(
    { startAt: '1788220800000', endAt: '1788307200000', segment: 'segment-1' },
    'website-1',
  );

  expect(filters.sessionPropertyFilters).toHaveLength(50);
  expect(filters).toHaveProperty('country49', 'eq.US');
});
