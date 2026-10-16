import { beforeEach, expect, test, vi } from 'vitest';
import { ROLES } from '@/lib/constants';
import { assertCurrentActorAuth } from './authorization';
import {
  addTeamUserByActor,
  getTeamUsers,
  joinTeamByAccessCode,
  transferTeamOwnership,
} from './teamUser';

const actorAuth = {
  authType: 'session' as const,
  user: { id: 'actor-1', username: 'actor', role: ROLES.user, isAdmin: false },
};
const targetAuth = {
  authType: 'session' as const,
  user: { id: 'target-user', username: 'target', role: ROLES.user, isAdmin: false },
};

vi.mock('./authorization', async importOriginal => ({
  ...(await importOriginal<typeof import('./authorization')>()),
  assertCurrentActorAuth: vi.fn(),
}));

const {
  transactionMock,
  pagedQueryMock,
  actorFindUnique,
  teamUserCreate,
  teamUserFindMany,
  teamUserUpdate,
  userForUpdate,
  userUpdate,
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  pagedQueryMock: vi.fn(),
  actorFindUnique: vi.fn(),
  teamUserCreate: vi.fn(),
  teamUserFindMany: vi.fn(),
  teamUserUpdate: vi.fn(),
  userForUpdate: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction: transactionMock,
    pagedQuery: pagedQueryMock,
    getSearchParameters: vi.fn(() => ({})),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  pagedQueryMock.mockResolvedValue({ data: [], count: 0, page: 1, pageSize: 20 });
  actorFindUnique.mockResolvedValue({ role: ROLES.user, deletedAt: null });
  teamUserCreate.mockResolvedValue({ id: 'membership-1' });
  teamUserFindMany.mockResolvedValue([{ id: 'owner-membership', userId: 'actor-1' }]);
  teamUserUpdate.mockResolvedValue({ id: 'new-owner-membership' });
  userForUpdate.mockResolvedValue([{ id: 'target-user', role: ROLES.user, deletedAt: null }]);
  userUpdate.mockResolvedValue({ id: 'target-user' });
  transactionMock.mockImplementation(async callback =>
    callback({
      $queryRaw: userForUpdate,
      user: {
        findUnique: actorFindUnique,
        findFirst: vi.fn().mockResolvedValue({ id: 'target-user' }),
        update: userUpdate,
      },
      team: { findFirst: vi.fn().mockResolvedValue({ id: 'team-1' }) },
      teamUser: {
        findFirst: vi.fn().mockImplementation(async ({ where }) => {
          if ('team' in where) return { role: ROLES.teamManager };
          if ('user' in where) return { id: 'new-owner-membership' };
          return null;
        }),
        create: teamUserCreate,
        findMany: teamUserFindMany,
        update: teamUserUpdate,
      },
    }),
  );
});

test('team member lists request primary-backed pagination', async () => {
  await getTeamUsers({ where: { teamId: 'team-1' } });

  expect(pagedQueryMock).toHaveBeenCalledWith(
    'teamUser',
    expect.objectContaining({ where: { teamId: 'team-1' } }),
    undefined,
    { usePrimary: true },
  );
});

test('a demoted manager cannot add a team member', async () => {
  actorFindUnique.mockResolvedValue({ role: ROLES.viewOnly, deletedAt: null });

  await expect(
    addTeamUserByActor('team-1', 'target-user', ROLES.teamMember, 'actor-1', actorAuth),
  ).rejects.toThrow('TEAM_ACTOR_NOT_AUTHORIZED');
  expect(teamUserCreate).not.toHaveBeenCalled();
});

test('an ordinary manager can still add a lower-ranked team member', async () => {
  await expect(
    addTeamUserByActor('team-1', 'target-user', ROLES.teamMember, 'actor-1', actorAuth),
  ).resolves.toMatchObject({ id: 'membership-1' });
  expect(teamUserCreate).toHaveBeenCalledOnce();
  expect(assertCurrentActorAuth).toHaveBeenCalledWith(
    expect.anything(),
    'actor-1',
    actorAuth,
    'TEAM_ACTOR_NOT_AUTHORIZED',
  );
  expect(userUpdate).toHaveBeenCalledWith({
    where: { id: 'target-user' },
    data: { updatedAt: expect.any(Date) },
  });
});

test('a demoted owner cannot transfer team ownership', async () => {
  actorFindUnique.mockResolvedValue({ role: ROLES.viewOnly, deletedAt: null });

  await expect(transferTeamOwnership('team-1', 'new-owner', 'actor-1', actorAuth)).rejects.toThrow(
    'TEAM_ACTOR_NOT_AUTHORIZED',
  );
  expect(teamUserUpdate).not.toHaveBeenCalled();
});

test('an ordinary owner can still transfer team ownership', async () => {
  await expect(
    transferTeamOwnership('team-1', 'new-owner', 'actor-1', actorAuth),
  ).resolves.toMatchObject({
    id: 'new-owner-membership',
  });
  expect(teamUserUpdate).toHaveBeenCalledTimes(2);
});

test.each([ROLES.viewOnly, ROLES.teamMember])(
  'a globally non-mutable %s account cannot join using an access code',
  async role => {
    userForUpdate.mockResolvedValue([{ id: 'target-user', role, deletedAt: null }]);

    await expect(
      joinTeamByAccessCode('target-user', 'team_abcdefghijklmnop', targetAuth),
    ).rejects.toThrow('TEAM_ACTOR_NOT_AUTHORIZED');
    expect(teamUserCreate).not.toHaveBeenCalled();
    expect(userForUpdate.mock.calls[0][0].join('')).toContain('FOR UPDATE');
  },
);

test.each([
  ['absent', []],
  ['deleted', [{ id: 'target-user', role: ROLES.user, deletedAt: new Date() }]],
])('an %s account cannot join using an access code', async (_state, userRows) => {
  userForUpdate.mockResolvedValue(userRows);

  await expect(
    joinTeamByAccessCode('target-user', 'team_abcdefghijklmnop', targetAuth),
  ).rejects.toThrow('TEAM_USER_NOT_FOUND');
  expect(teamUserCreate).not.toHaveBeenCalled();
});

test.each([ROLES.user, ROLES.admin])(
  'an active %s account can still join using an access code',
  async role => {
    userForUpdate.mockResolvedValue([{ id: 'target-user', role, deletedAt: null }]);

    await expect(
      joinTeamByAccessCode('target-user', 'team_abcdefghijklmnop', targetAuth),
    ).resolves.toMatchObject({ id: 'membership-1' });
    expect(userForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      teamUserCreate.mock.invocationCallOrder[0],
    );
    expect(teamUserCreate.mock.invocationCallOrder[0]).toBeLessThan(
      userUpdate.mock.invocationCallOrder[0],
    );
  },
);
