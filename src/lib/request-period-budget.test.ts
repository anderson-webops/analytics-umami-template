import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from './request';
import { withDateRange } from './schema';
import { getAuthenticatedQueryCost } from './share-query-budget';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  reserveAuthenticatedCost: vi.fn(),
  reserveShareCost: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ checkAuth: mocks.auth }));
vi.mock('@/lib/load', () => ({ fetchAccount: vi.fn(), fetchWebsite: vi.fn() }));
vi.mock('@/queries/prisma', () => ({ getWebsiteSegment: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewWebsite: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));
vi.mock('@/lib/query-admission', () => ({ getTenantQueryIdentity: vi.fn() }));
vi.mock('@/lib/query-concurrency', () => ({
  reserveAuthenticatedQueryLease: vi.fn(async () => ({ release: mocks.release })),
}));
vi.mock('@/lib/share-query-budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/share-query-budget')>()),
  reserveAuthenticatedQueryCost: mocks.reserveAuthenticatedCost,
  reserveShareQueryCost: mocks.reserveShareCost,
  reserveTenantQueryCost: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
  mocks.reserveAuthenticatedCost.mockResolvedValue({ blocked: false });
  mocks.reserveShareCost.mockResolvedValue({ blocked: false });
});

afterEach(() => vi.useRealTimers());

test.each(['owner', 'share'])(
  'expands the period before reserving the %s query budget',
  async mode => {
    mocks.auth.mockResolvedValue(
      mode === 'owner'
        ? { user: { id: 'period-owner' } }
        : { shareToken: { shareId: 'period-share', parameters: { allowFilter: false } } },
    );
    const result = await parseRequest(
      new Request('https://analytics.example/api/websites?period=12month&timezone=UTC'),
      withDateRange(),
    );

    expect(result.error).toBeUndefined();
    expect(result.query).not.toHaveProperty('period');
    expect(result.query.startAt).toBeTypeOf('number');
    expect(result.query.endAt).toBeTypeOf('number');
    const cost = getAuthenticatedQueryCost(result.query);
    expect(cost?.charge).toBeGreaterThan(1);
    const reserve = mode === 'owner' ? mocks.reserveAuthenticatedCost : mocks.reserveShareCost;
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve.mock.calls[0].slice(0, 2)).toEqual([
      mode === 'owner' ? 'period-owner' : 'period-share',
      cost?.charge,
    ]);
  },
);

test('keeps the admitted period snapshot stable if execution crosses a clock boundary', async () => {
  mocks.auth.mockResolvedValue({ user: { id: 'period-owner' } });
  const result = await parseRequest(
    new Request('https://analytics.example/api/websites?period=24h'),
    withDateRange(),
  );
  expect(result.error).toBeUndefined();
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  const filters = await getQueryFilters(result.query);
  expect(+filters.startDate).toBe(result.query.startAt);
  expect(+filters.endDate).toBe(result.query.endAt);
});

test('rejects an unknown period before any query reservation', async () => {
  mocks.auth.mockResolvedValue({ user: { id: 'period-owner' } });
  const result = await parseRequest(
    new Request('https://analytics.example/api/websites?period=1000year'),
    withDateRange(),
  );
  expect(result.error?.().status).toBe(400);
  expect(mocks.reserveAuthenticatedCost).not.toHaveBeenCalled();
  expect(mocks.reserveShareCost).not.toHaveBeenCalled();
});
