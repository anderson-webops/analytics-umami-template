import { beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import type { Auth } from '@/lib/types';
import { transferWebsiteByActor } from './website';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  invalidate: vi.fn(),
  currentAuth: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ default: { transaction: mocks.transaction } }));
vi.mock('@/lib/redis', () => ({ default: { enabled: true, client: { del: mocks.invalidate } } }));
vi.mock('./authorization', async importOriginal => ({
  ...(await importOriginal<typeof import('./authorization')>()),
  assertCurrentActorAuth: mocks.currentAuth,
}));

const actor = '11111111-1111-4111-8111-111111111111';
const site = '22222222-2222-4222-8222-222222222222';
const auth = { authType: 'session', user: { id: actor, role: 'admin' } } as Auth;

beforeEach(() => vi.resetAllMocks());

function setup(owner: { userId: string | null; teamId: string | null }) {
  const boardRows = [{ id: 'board-1' }, { id: 'board-2' }];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'recipient', role: 'admin' }) },
    team: { findFirst: vi.fn().mockResolvedValue({ id: 'destination-team' }) },
    teamUser: { findFirst: vi.fn().mockResolvedValue({ role: 'team-owner' }) },
    website: {
      findFirst: vi.fn().mockResolvedValue({ id: site, ...owner }),
      update: vi.fn(async ({ data }) => ({ id: site, ...data })),
    },
    board: { findMany: vi.fn().mockResolvedValue(boardRows), updateMany: vi.fn() },
    share: { deleteMany: vi.fn() },
  };
  mocks.transaction.mockImplementation(async callback => callback(tx));
  return tx;
}

test.each([
  [
    { userId: null, teamId: 'old-team' },
    { userId: 'recipient' },
    { userId: 'recipient', teamId: null },
  ],
  [
    { userId: 'old-user', teamId: null },
    { teamId: 'destination-team' },
    { userId: null, teamId: 'destination-team' },
  ],
  [
    { userId: null, teamId: 'old-team' },
    { teamId: 'destination-team' },
    { userId: null, teamId: 'destination-team' },
  ],
] as const)(
  'moves only matching single-website boards from owner %j',
  async (owner, destination, nextOwner) => {
    const tx = setup(owner);
    await transferWebsiteByActor(site, destination, actor, auth);
    const expectedScope = {
      type: 'website',
      parameters: { path: ['websiteId'], equals: site },
      ...(owner.teamId ? { teamId: owner.teamId } : { userId: owner.userId, teamId: null }),
    };
    expect(mocks.currentAuth).toHaveBeenCalledWith(
      tx,
      actor,
      auth,
      'WEBSITE_TRANSFER_NOT_AUTHORIZED',
    );
    expect(tx.board.findMany).toHaveBeenCalledWith({ where: expectedScope, select: { id: true } });
    expect(tx.board.updateMany).toHaveBeenCalledWith({
      where: { ...expectedScope, id: { in: ['board-1', 'board-2'] } },
      data: nextOwner,
    });
    expect(tx.share.deleteMany).toHaveBeenCalledWith({
      where: { entityId: site, shareType: ENTITY_TYPE.website },
    });
    expect(tx.share.deleteMany).toHaveBeenCalledWith({
      where: { entityId: { in: ['board-1', 'board-2'] }, shareType: ENTITY_TYPE.board },
    });
    expect(tx.website.update).toHaveBeenCalledWith({
      where: { id: site },
      data: { ...nextOwner, collectionGeneration: { increment: 1 } },
    });
    expect(tx.share.deleteMany.mock.invocationCallOrder[1]).toBeLessThan(
      tx.board.updateMany.mock.invocationCallOrder[0],
    );
    expect(tx.board.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.website.update.mock.invocationCallOrder[0],
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(`website:${site}`);
  },
);

test('a no-op transfer preserves boards, shares and collection generation', async () => {
  const tx = setup({ userId: 'recipient', teamId: null });
  await transferWebsiteByActor(site, { userId: 'recipient' }, actor, auth);
  expect(tx.board.findMany).not.toHaveBeenCalled();
  expect(tx.board.updateMany).not.toHaveBeenCalled();
  expect(tx.share.deleteMany).not.toHaveBeenCalled();
  expect(tx.website.update).toHaveBeenCalledWith({
    where: { id: site },
    data: { userId: 'recipient', teamId: null },
  });
});

test('leaves unrelated boards and public shares untouched when no matching boards exist', async () => {
  const tx = setup({ userId: 'old-user', teamId: null });
  tx.board.findMany.mockResolvedValue([]);
  await transferWebsiteByActor(site, { userId: 'recipient' }, actor, auth);
  expect(tx.board.updateMany).not.toHaveBeenCalled();
  expect(tx.share.deleteMany).toHaveBeenCalledTimes(1);
});

test('failed board-share revocation prevents the ownership change and cache eviction', async () => {
  const tx = setup({ userId: 'old-user', teamId: null });
  tx.share.deleteMany
    .mockResolvedValueOnce({ count: 1 })
    .mockRejectedValueOnce(new Error('Synthetic board-share failure'));
  await expect(transferWebsiteByActor(site, { userId: 'recipient' }, actor, auth)).rejects.toThrow(
    'Synthetic board-share failure',
  );
  expect(tx.board.updateMany).not.toHaveBeenCalled();
  expect(tx.website.update).not.toHaveBeenCalled();
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

test('changed actor credentials stop board and website mutations', async () => {
  const tx = setup({ userId: 'old-user', teamId: null });
  mocks.currentAuth.mockRejectedValue(new Error('WEBSITE_TRANSFER_NOT_AUTHORIZED'));
  await expect(transferWebsiteByActor(site, { userId: 'recipient' }, actor, auth)).rejects.toThrow(
    'WEBSITE_TRANSFER_NOT_AUTHORIZED',
  );
  expect(tx.board.findMany).not.toHaveBeenCalled();
  expect(tx.share.deleteMany).not.toHaveBeenCalled();
  expect(tx.website.update).not.toHaveBeenCalled();
});
