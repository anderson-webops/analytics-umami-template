import { beforeEach, expect, test, vi } from 'vitest';
import { ROLES } from '@/lib/constants';
import { addTeamUserByActor, getTeamUsers, transferTeamOwnership } from './teamUser';

const {
  transactionMock,
  pagedQueryMock,
  actorFindUnique,
  teamUserCreate,
  teamUserFindMany,
  teamUserUpdate,
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  pagedQueryMock: vi.fn(),
  actorFindUnique: vi.fn(),
  teamUserCreate: vi.fn(),
  teamUserFindMany: vi.fn(),
  teamUserUpdate: vi.fn(),
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
  transactionMock.mockImplementation(async callback =>
    callback({
      user: {
        findUnique: actorFindUnique,
        findFirst: vi.fn().mockResolvedValue({ id: 'target-user' }),
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
    addTeamUserByActor('team-1', 'target-user', ROLES.teamMember, 'actor-1'),
  ).rejects.toThrow('TEAM_ACTOR_NOT_AUTHORIZED');
  expect(teamUserCreate).not.toHaveBeenCalled();
});

test('an ordinary manager can still add a lower-ranked team member', async () => {
  await expect(
    addTeamUserByActor('team-1', 'target-user', ROLES.teamMember, 'actor-1'),
  ).resolves.toMatchObject({ id: 'membership-1' });
  expect(teamUserCreate).toHaveBeenCalledOnce();
});

test('a demoted owner cannot transfer team ownership', async () => {
  actorFindUnique.mockResolvedValue({ role: ROLES.viewOnly, deletedAt: null });

  await expect(transferTeamOwnership('team-1', 'new-owner', 'actor-1')).rejects.toThrow(
    'TEAM_ACTOR_NOT_AUTHORIZED',
  );
  expect(teamUserUpdate).not.toHaveBeenCalled();
});

test('an ordinary owner can still transfer team ownership', async () => {
  await expect(transferTeamOwnership('team-1', 'new-owner', 'actor-1')).resolves.toMatchObject({
    id: 'new-owner-membership',
  });
  expect(teamUserUpdate).toHaveBeenCalledTimes(2);
});
