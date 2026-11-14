import { beforeEach, expect, test, vi } from 'vitest';
import type { Auth } from '@/lib/types';
import { updateErrorIssue } from './error';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), currentAuth: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { transaction: mocks.transaction } }));
vi.mock('@/lib/redis', () => ({ default: { enabled: false } }));
vi.mock('./authorization', async importOriginal => ({
  ...(await importOriginal<typeof import('./authorization')>()),
  assertCurrentActorAuth: mocks.currentAuth,
}));

const WEBSITE = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const auth = { authType: 'session', user: { id: ACTOR, role: 'admin' } } as Auth;

beforeEach(() => vi.resetAllMocks());

function setup() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findFirst: vi.fn().mockResolvedValue({ role: 'user' }) },
    website: { findFirst: vi.fn().mockResolvedValue({ id: WEBSITE, userId: ACTOR, teamId: null }) },
    teamUser: { findFirst: vi.fn().mockResolvedValue({ role: 'team-manager' }) },
    errorIssue: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  mocks.transaction.mockImplementation(async operation => operation(tx));
  return tx;
}

test.each(['resolved', 'unresolved', 'ignored'] as const)(
  'status %s is written only after current actor and website checks',
  async status => {
    const tx = setup();
    await updateErrorIssue(WEBSITE, ISSUE, status, auth);
    expect(mocks.currentAuth).toHaveBeenCalledWith(tx, ACTOR, auth);
    expect(tx.website.findFirst).toHaveBeenCalledWith({
      where: { id: WEBSITE, deletedAt: null },
      select: { id: true, userId: true, teamId: true },
    });
    expect(tx.errorIssue.updateMany).toHaveBeenCalledWith({
      where: { id: ISSUE, websiteId: WEBSITE },
      data: { status, resolvedAt: status === 'resolved' ? expect.any(Date) : null },
    });
    expect(tx.website.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      tx.errorIssue.updateMany.mock.invocationCallOrder[0],
    );
    expect(
      tx.$queryRaw.mock.calls.some(([query]) => query.join('').includes('pg_advisory_xact_lock')),
    ).toBe(true);
  },
);

test('a demoted global actor cannot mutate error state despite earlier permission checks', async () => {
  const tx = setup();
  tx.user.findFirst.mockResolvedValue({ role: 'view-only' });
  await expect(updateErrorIssue(WEBSITE, ISSUE, 'resolved', auth)).rejects.toThrow(
    'ENTITY_ACTOR_NOT_AUTHORIZED',
  );
  expect(tx.errorIssue.updateMany).not.toHaveBeenCalled();
});

test('a transferred website is no longer mutable by its previous owner', async () => {
  const tx = setup();
  tx.website.findFirst.mockResolvedValue({ id: WEBSITE, userId: 'other-owner', teamId: null });
  await expect(updateErrorIssue(WEBSITE, ISSUE, 'resolved', auth)).rejects.toThrow(
    'ENTITY_ACTOR_NOT_AUTHORIZED',
  );
  expect(tx.errorIssue.updateMany).not.toHaveBeenCalled();
});

test('a demoted team membership cannot mutate error state', async () => {
  const tx = setup();
  tx.website.findFirst.mockResolvedValue({ id: WEBSITE, userId: null, teamId: WEBSITE });
  tx.teamUser.findFirst.mockResolvedValue({ role: 'team-view-only' });
  await expect(updateErrorIssue(WEBSITE, ISSUE, 'resolved', auth)).rejects.toThrow(
    'ENTITY_ACTOR_NOT_AUTHORIZED',
  );
  expect(tx.errorIssue.updateMany).not.toHaveBeenCalled();
});

test('a missing website or post-reset issue cannot be recreated by a stale request', async () => {
  const tx = setup();
  tx.website.findFirst.mockResolvedValueOnce(null);
  await expect(updateErrorIssue(WEBSITE, ISSUE, 'resolved', auth)).rejects.toThrow(
    'ENTITY_NOT_FOUND',
  );
  tx.errorIssue.updateMany.mockResolvedValue({ count: 0 });
  await expect(updateErrorIssue(WEBSITE, ISSUE, 'resolved', auth)).rejects.toThrow(
    'ERROR_ISSUE_NOT_FOUND',
  );
  expect(tx.errorIssue.updateMany).toHaveBeenCalledTimes(1);
});

test('current credentials are rechecked during serializable retries', async () => {
  const tx = setup();
  tx.errorIssue.updateMany.mockRejectedValueOnce({ code: 'P2034' });
  mocks.transaction
    .mockImplementationOnce(async operation => operation(tx))
    .mockImplementationOnce(async operation => {
      tx.user.findFirst.mockResolvedValue({ role: 'view-only' });
      return operation(tx);
    });
  await expect(updateErrorIssue(WEBSITE, ISSUE, 'resolved', auth)).rejects.toThrow(
    'ENTITY_ACTOR_NOT_AUTHORIZED',
  );
  expect(mocks.currentAuth).toHaveBeenCalledTimes(2);
  expect(tx.errorIssue.updateMany).toHaveBeenCalledTimes(1);
});

test('missing or revoked authentication blocks the transaction before writes', async () => {
  const tx = setup();
  await expect(updateErrorIssue(WEBSITE, ISSUE, 'resolved', {} as Auth)).rejects.toThrow(
    'ENTITY_ACTOR_NOT_AUTHORIZED',
  );
  mocks.currentAuth.mockRejectedValue(new Error('ENTITY_ACTOR_NOT_AUTHORIZED'));
  await expect(updateErrorIssue(WEBSITE, ISSUE, 'resolved', auth)).rejects.toThrow(
    'ENTITY_ACTOR_NOT_AUTHORIZED',
  );
  expect(tx.errorIssue.updateMany).not.toHaveBeenCalled();
});
