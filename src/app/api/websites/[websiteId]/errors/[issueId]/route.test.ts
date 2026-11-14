import { beforeEach, expect, test, vi } from 'vitest';
import { ErrorQueryLimitError } from '@/lib/errors/query-limits';
import { GET, PATCH } from './route';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  update: vi.fn(),
  stats: vi.fn(),
  permission: vi.fn(),
}));
vi.mock('@/lib/errors/access', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/errors/access')>()),
  errorAccess: mocks.access,
}));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/permissions', () => ({
  canUpdateWebsite: mocks.permission,
  canViewAuthenticatedWebsite: vi.fn(),
}));
vi.mock('@/queries/prisma/error', () => ({ updateErrorIssue: mocks.update }));
vi.mock('@/queries/sql/errors/query', () => ({ getErrorStats: mocks.stats }));

const WEBSITE = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const auth = { authType: 'session', user: { id: 'actor' } };
const context = { params: Promise.resolve({ websiteId: WEBSITE, issueId: ISSUE }) };
const request = (method: string) => new Request('https://analytics.example/api/errors', { method });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({
    auth,
    website: { id: WEBSITE },
    issue: { id: ISSUE, status: 'unresolved' },
    scope: { websiteId: WEBSITE },
    query: {},
    body: { status: 'resolved' },
  });
  mocks.stats.mockResolvedValue({ occurrences: 1 });
  mocks.permission.mockResolvedValue(false);
});

test('GET returns private scoped statistics with current update permission', async () => {
  const response = await GET(request('GET'), context);
  expect(await response.json()).toMatchObject({ id: ISSUE, occurrences: 1, canUpdate: false });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(mocks.stats).toHaveBeenCalledWith({ websiteId: WEBSITE }, {}, ISSUE);
  expect(mocks.permission).toHaveBeenCalledWith(auth, WEBSITE);
});

test('GET reports bounded status-query rejection without partial statistics', async () => {
  mocks.stats.mockRejectedValue(new ErrorQueryLimitError());
  const response = await GET(request('GET'), context);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'error-filter-too-broad' } });
});

test('PATCH delegates to the guarded current-authorization mutation', async () => {
  const response = await PATCH(request('PATCH'), context);
  expect(response.status).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith(WEBSITE, ISSUE, 'resolved', auth);
  expect(mocks.access.mock.calls[0][3]).toBe(true);
});

test.each(['ENTITY_NOT_FOUND', 'ERROR_ISSUE_NOT_FOUND'])(
  'PATCH preserves unavailable state after %s',
  async message => {
    mocks.update.mockRejectedValue(new Error(message));
    expect((await PATCH(request('PATCH'), context)).status).toBe(404);
  },
);

test('PATCH rejects lost update permission instead of persisting against stale admission', async () => {
  mocks.update.mockRejectedValue(new Error('ENTITY_ACTOR_NOT_AUTHORIZED'));
  expect((await PATCH(request('PATCH'), context)).status).toBe(401);
});

test('access rejection prevents both reporting and mutation calls', async () => {
  mocks.access.mockResolvedValue({ response: Response.json({}, { status: 401 }) });
  expect((await GET(request('GET'), context)).status).toBe(401);
  expect((await PATCH(request('PATCH'), context)).status).toBe(401);
  expect(mocks.stats).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});
