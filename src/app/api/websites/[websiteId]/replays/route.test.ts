import { beforeEach, describe, expect, test, vi } from 'vitest';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { GET as getReplays } from './route';
import { GET as getSavedReplays } from './saved/route';

const state = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getQueryFilters: vi.fn(),
  canView: vi.fn(),
  getSessionReplays: vi.fn(),
  getSavedReplays: vi.fn(),
  getDistinctIds: vi.fn(),
}));
vi.mock('@/lib/request', () => ({
  parseRequest: state.parseRequest,
  getQueryFilters: state.getQueryFilters,
}));
vi.mock('@/permissions', () => ({ canViewAuthenticatedWebsite: state.canView }));
vi.mock('@/queries/sql', () => ({
  getSessionReplays: state.getSessionReplays,
  getReplayDistinctIds: state.getDistinctIds,
}));
vi.mock('@/queries/prisma/sessionReplay', () => ({ getSavedReplays: state.getSavedReplays }));

const websiteId = '11111111-1111-4111-8111-111111111111';
const visitId = '22222222-2222-4222-8222-222222222222';
const filters = { startDate: new Date('2026-11-01'), endDate: new Date('2026-11-14') };
const context = { params: Promise.resolve({ websiteId }) };
const row = { id: visitId, visitId, name: 'retained' };

beforeEach(() => {
  vi.resetAllMocks();
  state.parseRequest.mockImplementation(async (request, schema) => {
    const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return { error: () => Response.json({}, { status: 400 }) };
    return { auth: { user: { id: 'owner' } }, query: parsed.data };
  });
  state.canView.mockResolvedValue(true);
  state.getQueryFilters.mockResolvedValue(filters);
  state.getSessionReplays.mockResolvedValue({ data: [row], count: 1 });
  state.getSavedReplays.mockResolvedValue({ data: [row], count: 1 });
  state.getDistinctIds.mockResolvedValue({ [visitId]: ['verified'] });
});

describe.each([
  ['listing', getReplays, false],
  ['saved', getSavedReplays, true],
] as const)('%s replay route', (_name, handler, saved) => {
  const request = (suffix = '') =>
    new Request(
      'https://analytics.example/api/websites/' +
        websiteId +
        '/replays' +
        (saved ? '/saved?' : '?startAt=1793491200000&endAt=1794614400000&') +
        suffix,
    );

  test('returns identity-enriched rows without public caching', async () => {
    const response = await handler(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      data: [{ ...row, distinctIds: ['verified'] }],
      count: 1,
    });
    expect(state.canView).toHaveBeenCalledWith({ user: { id: 'owner' } }, websiteId);
    expect(state.getDistinctIds).toHaveBeenCalledWith(
      websiteId,
      [visitId],
      ...(saved ? [] : [filters]),
    );
  });

  test('authorizes interactive access before either source read', async () => {
    state.canView.mockResolvedValue(false);
    expect((await handler(request(), context)).status).toBe(401);
    expect(state.getSessionReplays).not.toHaveBeenCalled();
    expect(state.getSavedReplays).not.toHaveBeenCalled();
    expect(state.getDistinctIds).not.toHaveBeenCalled();
  });

  test('preserves parsing and admission errors before reads', async () => {
    state.parseRequest.mockResolvedValue({ error: () => Response.json({}, { status: 429 }) });
    expect((await handler(request(), context)).status).toBe(429);
    expect(state.canView).not.toHaveBeenCalled();
    expect(state.getDistinctIds).not.toHaveBeenCalled();
  });

  test('rejects out-of-range page sizes using the real shared schema', async () => {
    expect((await handler(request('pageSize=501'), context)).status).toBe(400);
    expect(state.canView).not.toHaveBeenCalled();
  });

  test('accounts for additional paged identity work', async () => {
    await handler(request('page=2&pageSize=100'), context);
    const options = state.parseRequest.mock.calls[0][2];
    expect(options.shareQueryWorkMultiplier({ page: 2, pageSize: 100 })).toBeGreaterThan(2);
    expect(options.shareQueryWorkMultiplier({ page: 10001, pageSize: 100 })).toBeNull();
    if (saved) expect(options.budgetShareQuery).toBe(true);
  });

  test('rejects excessive identity expansion without partial output', async () => {
    state.getDistinctIds.mockRejectedValue(new IdentitySearchTooBroadError());
    const response = await handler(request(), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: 'Identity search is too broad.' },
    });
  });

  test('propagates unrelated database failures', async () => {
    state.getDistinctIds.mockRejectedValue(new Error('storage unavailable'));
    await expect(handler(request(), context)).rejects.toThrow('storage unavailable');
  });

  test('represents missing verified labels as an empty list', async () => {
    state.getDistinctIds.mockResolvedValue({});
    expect(await (await handler(request(), context)).json()).toEqual({
      data: [{ ...row, distinctIds: [] }],
      count: 1,
    });
  });
});
