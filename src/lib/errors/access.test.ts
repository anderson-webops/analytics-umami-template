import { beforeEach, expect, test, vi } from 'vitest';
import { errorAccess, withErrorQuery } from './access';
import { ErrorQueryLimitError } from './query-limits';
import { errorQuerySchema } from './schema';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  view: vi.fn(),
  update: vi.fn(),
  website: vi.fn(),
  issue: vi.fn(),
  replicaWebsite: vi.fn(),
}));
vi.mock('@/lib/request', () => ({ parseRequest: mocks.parse }));
vi.mock('@/permissions', () => ({
  canUpdateWebsite: mocks.update,
  canViewAuthenticatedWebsite: mocks.view,
}));
vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({
        website: { findUnique: mocks.website },
        errorIssue: { findFirst: mocks.issue },
      }),
      website: { findUnique: mocks.replicaWebsite },
    },
  },
}));

const WEBSITE = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const auth = { authType: 'session', user: { id: 'actor' } };
const request = () => new Request(`https://analytics.example/api/websites/${WEBSITE}/errors`);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.parse.mockResolvedValue({ auth, query: {} });
  mocks.view.mockResolvedValue(true);
  mocks.update.mockResolvedValue(true);
  mocks.website.mockResolvedValue({ id: WEBSITE, deletedAt: null, resetAt: null });
  mocks.issue.mockResolvedValue({ id: ISSUE });
});

test('error reads use current primary metadata and scoped issue lookup', async () => {
  const result = await errorAccess(
    request(),
    { websiteId: WEBSITE, issueId: ISSUE },
    errorQuerySchema,
  );
  expect(result.scope).toEqual({ websiteId: WEBSITE, resetAt: null });
  expect(mocks.issue).toHaveBeenCalledWith({ where: { id: ISSUE, websiteId: WEBSITE } });
  expect(mocks.replicaWebsite).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});

test('date-free error detail reads still receive admission, paging-work and concurrency limits', async () => {
  await errorAccess(request(), { websiteId: WEBSITE, issueId: ISSUE });
  const [, schema, options] = mocks.parse.mock.calls[0];
  expect(schema.safeParse({}).success).toBe(true);
  expect(schema.safeParse({ unreviewed: true }).success).toBe(false);
  expect(options.budgetShareQuery).toBe(true);
  expect(options.authenticatedQueryFanout).toBe(5);
  expect(options.shareQueryWorkMultiplier({ page: 10, pageSize: 100 })).toBeGreaterThan(
    options.shareQueryWorkMultiplier({ page: 1, pageSize: 25 }),
  );
  expect(options.shareQueryWorkMultiplier({ page: -1 })).toBeNull();
});

test.each([
  null,
  { shareToken: { websiteId: WEBSITE } },
  { user: { id: 'actor' }, shareToken: { websiteId: WEBSITE } },
])('rejects non-user and share authentication %j', async nextAuth => {
  mocks.parse.mockResolvedValue({ auth: nextAuth });
  expect((await errorAccess(request(), { websiteId: WEBSITE })).response.status).toBe(401);
  expect(mocks.website).not.toHaveBeenCalled();
});

test('invalid path ids stop before authentication and database access', async () => {
  expect((await errorAccess(request(), { websiteId: 'invalid' })).response.status).toBe(400);
  expect(mocks.parse).not.toHaveBeenCalled();
});

test('read denial stops metadata access', async () => {
  mocks.view.mockResolvedValue(false);
  expect((await errorAccess(request(), { websiteId: WEBSITE })).response.status).toBe(401);
  expect(mocks.website).not.toHaveBeenCalled();
});

test('writes require update permission separately from view permission', async () => {
  mocks.update.mockResolvedValue(false);
  expect(
    (await errorAccess(request(), { websiteId: WEBSITE }, undefined, true)).response.status,
  ).toBe(401);
  expect(mocks.view).not.toHaveBeenCalled();
  expect(mocks.website).not.toHaveBeenCalled();
});

test.each([null, { id: WEBSITE, deletedAt: new Date() }])(
  'rejects unavailable websites %j',
  async website => {
    mocks.website.mockResolvedValue(website);
    expect((await errorAccess(request(), { websiteId: WEBSITE })).response.status).toBe(404);
  },
);

test('a foreign or removed issue is unavailable within the requested website', async () => {
  mocks.issue.mockResolvedValue(null);
  expect(
    (await errorAccess(request(), { websiteId: WEBSITE, issueId: ISSUE })).response.status,
  ).toBe(404);
});

test('error results are private and bounded-filter failures are actionable', async () => {
  const good = await withErrorQuery(async () => Response.json({ ok: true }));
  expect(good.headers.get('Cache-Control')).toBe('no-store');
  const response = await withErrorQuery(async () => {
    throw new ErrorQueryLimitError();
  });
  expect(response.status).toBe(400);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ error: { code: 'error-filter-too-broad' } });
});

test('unexpected provider failures remain failures', async () => {
  await expect(
    withErrorQuery(async () => {
      throw new Error('Synthetic provider failure');
    }),
  ).rejects.toThrow('Synthetic provider failure');
});
