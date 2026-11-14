import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Auth } from '@/lib/types';
import { deleteTeam } from './team';
import { deleteUser } from './user';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auth: vi.fn(),
  administrator: vi.fn(),
  clickhouseDelete: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ default: { transaction: mocks.transaction } }));
vi.mock('@/lib/redis', () => ({ default: { enabled: true, client: { del: mocks.invalidate } } }));
vi.mock('@/queries/sql/deleteCollectionSources', () => ({
  deleteClickhouseCollectionSources: mocks.clickhouseDelete,
}));
vi.mock('./authorization', async importOriginal => ({
  ...(await importOriginal<typeof import('./authorization')>()),
  assertCurrentActorAuth: mocks.auth,
  assertActorIsAdministrator: mocks.administrator,
  runSerializable: (operation, options) => mocks.transaction(operation, options),
  runSerializedUserMutation: (operation, options) => mocks.transaction(operation, options),
  runActiveSessionMutation: vi.fn(),
  runCredentialRevocationMutation: vi.fn(),
  SessionRevokedError: class extends Error {},
}));

const WEBSITE = '11111111-1111-4111-8111-111111111111';
const LINK = '22222222-2222-4222-8222-222222222222';
const PIXEL = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const auth = { authType: 'session', user: { id: ACTOR, role: 'admin' } } as Auth;

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

function setup() {
  const calls: string[] = [];
  const model = (name: string) => ({
    findFirst: vi.fn().mockResolvedValue({ id: OWNER, role: 'admin' }),
    findUnique: vi.fn().mockResolvedValue({ id: OWNER, role: 'user', deletedAt: null }),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    deleteMany: vi.fn(async () => {
      calls.push(name);
      return { count: 1 };
    }),
    delete: vi.fn(async () => {
      calls.push(name);
      return { id: OWNER };
    }),
    updateMany: vi.fn(async () => {
      calls.push(name);
      return { count: 1 };
    }),
    update: vi.fn(async () => {
      calls.push(name);
      return { id: OWNER };
    }),
  });
  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock');
      return [];
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
    user: model('user'),
    team: model('team'),
    teamUser: model('teamUser'),
    website: model('website'),
    link: model('link'),
    pixel: model('pixel'),
    board: model('board'),
    errorEvent: model('errorEvent'),
    errorIssue: model('errorIssue'),
    errorRateLimit: model('errorRateLimit'),
    sessionReplaySaved: model('sessionReplaySaved'),
    sessionReplay: model('sessionReplay'),
    heatmapEvent: model('heatmapEvent'),
    revenue: model('revenue'),
    attestedRevenueMovement: model('attestedRevenueMovement'),
    eventData: model('eventData'),
    sessionData: model('sessionData'),
    sessionLink: model('sessionLink'),
    websiteEvent: model('websiteEvent'),
    session: model('session'),
    report: model('report'),
    segment: model('segment'),
    annotation: model('annotation'),
    share: model('share'),
  };
  tx.website.findMany.mockResolvedValue([{ id: WEBSITE, collectionGeneration: 0 }]);
  tx.link.findMany.mockResolvedValue([{ id: LINK, slug: 'synthetic-link', deletedAt: null }]);
  tx.pixel.findMany.mockResolvedValue([{ id: PIXEL, slug: 'synthetic-pixel', deletedAt: null }]);
  mocks.transaction.mockImplementation(async operation => operation(tx));
  mocks.clickhouseDelete.mockImplementation(async () => {
    calls.push('clickhouse');
  });
  return { tx, calls };
}

test.each([
  ['team', false],
  ['team', true],
  ['user', false],
  ['user', true],
] as const)('%s erasure includes all error stores in cloud mode %s', async (kind, cloud) => {
  vi.stubEnv('CLOUD_MODE', String(cloud));
  const { tx, calls } = setup();
  await (kind === 'team' ? deleteTeam(OWNER, ACTOR, auth) : deleteUser(OWNER, ACTOR, auth));
  expect(mocks.auth).toHaveBeenCalledWith(
    tx,
    ACTOR,
    auth,
    kind === 'team' ? 'TEAM_ACTOR_NOT_AUTHORIZED' : 'ADMIN_AUTHORIZATION_CHANGED',
  );
  expect(mocks.clickhouseDelete).toHaveBeenCalledWith([WEBSITE, LINK, PIXEL]);
  for (const name of ['errorEvent', 'errorIssue', 'errorRateLimit'] as const) {
    expect(tx[name].deleteMany).toHaveBeenCalledWith({ where: { websiteId: { in: [WEBSITE] } } });
    expect(calls.indexOf(name)).toBeGreaterThan(calls.indexOf('clickhouse'));
    expect(calls.indexOf(name)).toBeLessThan(calls.indexOf('websiteEvent'));
  }
  expect(calls.indexOf('errorEvent')).toBeLessThan(calls.indexOf('errorIssue'));
  expect(mocks.invalidate).toHaveBeenCalledWith(`website:${WEBSITE}`);
});

test.each(['team', 'user'] as const)(
  '%s erasure stops before relational writes when cross-engine cleanup fails',
  async kind => {
    const { tx } = setup();
    mocks.clickhouseDelete.mockRejectedValue(new Error('Synthetic cleanup failure'));
    await expect(
      kind === 'team' ? deleteTeam(OWNER, ACTOR, auth) : deleteUser(OWNER, ACTOR, auth),
    ).rejects.toThrow('Synthetic cleanup failure');
    expect(tx.errorEvent.deleteMany).not.toHaveBeenCalled();
    expect(tx.errorIssue.deleteMany).not.toHaveBeenCalled();
    expect(tx.website.deleteMany).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  },
);

test.each(['team', 'user'] as const)(
  '%s erasure propagates error-row cleanup failures',
  async kind => {
    const { tx } = setup();
    tx.errorEvent.deleteMany.mockRejectedValue(new Error('Synthetic error-row failure'));
    await expect(
      kind === 'team' ? deleteTeam(OWNER, ACTOR, auth) : deleteUser(OWNER, ACTOR, auth),
    ).rejects.toThrow('Synthetic error-row failure');
    expect(tx.errorIssue.deleteMany).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
    expect(tx.team.deleteMany).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  },
);

test('user erasure still requires all active owned resources to be reassigned', async () => {
  const { tx } = setup();
  tx.website.count.mockResolvedValue(1);
  await expect(deleteUser(OWNER, ACTOR, auth)).rejects.toThrow('USER_OWNS_RESOURCES');
  expect(mocks.clickhouseDelete).not.toHaveBeenCalled();
  expect(tx.errorEvent.deleteMany).not.toHaveBeenCalled();
});
