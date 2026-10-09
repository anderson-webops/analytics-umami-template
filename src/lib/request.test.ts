import { beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { checkAuth } from '@/lib/auth';
import { fetchWebsite } from '@/lib/load';
import { getWebsiteSegment } from '@/queries/prisma';
import { getQueryFilters, parseRequest } from './request';
import { readRequestBodyBytes } from './request-body';
import { fieldsParam, reportResultSchema, searchParams, withDateRange } from './schema';
import { reserveShareQueryCost } from './share-query-budget';

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
  getWebsiteSegment: vi.fn(),
}));

const checkAuthMock = vi.mocked(checkAuth);
const fetchWebsiteMock = vi.mocked(fetchWebsite);
const getWebsiteSegmentMock = vi.mocked(getWebsiteSegment);

beforeEach(() => {
  checkAuthMock.mockReset();
  fetchWebsiteMock.mockReset();
  getWebsiteSegmentMock.mockReset();
  fetchWebsiteMock.mockResolvedValue({ id: 'website-1' } as any);
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
