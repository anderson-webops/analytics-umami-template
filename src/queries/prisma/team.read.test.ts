import { beforeEach, expect, test, vi } from 'vitest';
import {
  deleteTeam,
  getAllUserTeams,
  getTeamAccessCodeForActor,
  getTeams,
  getUserTeams,
  updateTeam,
} from './team';

const {
  pagedQueryMock,
  transactionMock,
  userFindFirstMock,
  teamFindFirstMock,
  membershipFindFirstMock,
  teamUpdateMock,
  websiteFindManyMock,
  primaryTeamFindManyMock,
  replicaTeamFindManyMock,
} = vi.hoisted(() => ({
  pagedQueryMock: vi.fn(),
  transactionMock: vi.fn(),
  userFindFirstMock: vi.fn(),
  teamFindFirstMock: vi.fn(),
  membershipFindFirstMock: vi.fn(),
  teamUpdateMock: vi.fn(),
  websiteFindManyMock: vi.fn(),
  primaryTeamFindManyMock: vi.fn(),
  replicaTeamFindManyMock: vi.fn(),
}));

const TEAM_ID = '3979e857-a987-4795-9380-12024a4440a9';
const ACTOR_ID = '1085fb06-4dd8-4fc8-b94a-c79146fa8947';
const ACCESS_CODE = 'team_privatecode123';

vi.mock('@/lib/prisma', () => ({
  default: {
    getSearchParameters: vi.fn(() => ({})),
    pagedQuery: pagedQueryMock,
    transaction: transactionMock,
    client: {
      $primary: () => ({ team: { findMany: primaryTeamFindManyMock } }),
      team: { findMany: replicaTeamFindManyMock },
    },
  },
}));

beforeEach(() => {
  pagedQueryMock.mockReset();
  pagedQueryMock.mockResolvedValue({ data: [], count: 0, page: 1, pageSize: 20 });
  transactionMock.mockReset();
  transactionMock.mockImplementation(async callback =>
    callback({
      user: { findFirst: userFindFirstMock },
      team: { findFirst: teamFindFirstMock, update: teamUpdateMock },
      teamUser: { findFirst: membershipFindFirstMock },
      website: { findMany: websiteFindManyMock },
    }),
  );
  userFindFirstMock.mockReset();
  userFindFirstMock.mockResolvedValue({ role: 'user' });
  teamFindFirstMock.mockReset();
  teamFindFirstMock.mockResolvedValue({
    accessCode: ACCESS_CODE,
    members: [{ role: 'team-manager' }],
  });
  membershipFindFirstMock.mockReset();
  membershipFindFirstMock.mockResolvedValue({ role: 'team-manager' });
  teamUpdateMock.mockReset();
  teamUpdateMock.mockResolvedValue({ id: TEAM_ID, accessCode: ACCESS_CODE });
  websiteFindManyMock.mockReset();
  primaryTeamFindManyMock.mockReset();
  replicaTeamFindManyMock.mockReset();
});

test('team lists omit invitation codes before reading from Prisma', async () => {
  await getUserTeams('user-1');

  expect(pagedQueryMock).toHaveBeenCalledWith(
    'team',
    expect.objectContaining({
      omit: { accessCode: true },
      where: expect.objectContaining({ members: { some: { userId: 'user-1' } } }),
    }),
    expect.anything(),
    { usePrimary: true },
  );
});

test('admin team lists also omit invitation codes', async () => {
  await getTeams({ include: { members: true }, omit: { logoUrl: true, accessCode: false } }, {});

  expect(pagedQueryMock).toHaveBeenCalledWith(
    'team',
    expect.objectContaining({
      include: { members: true },
      omit: { logoUrl: true, accessCode: true },
    }),
    expect.anything(),
    { usePrimary: true },
  );
});

test('login and verification team names use current primary membership', async () => {
  replicaTeamFindManyMock.mockResolvedValue([{ id: TEAM_ID, name: 'revoked-team' }]);
  primaryTeamFindManyMock.mockResolvedValue([]);

  await expect(getAllUserTeams(ACTOR_ID)).resolves.toEqual([]);
  expect(primaryTeamFindManyMock).toHaveBeenCalledWith({
    where: { deletedAt: null, members: { some: { userId: ACTOR_ID } } },
    select: { id: true, name: true, logoUrl: true },
  });
  expect(replicaTeamFindManyMock).not.toHaveBeenCalled();
});

test('current manager permissions and code are read from the primary database', async () => {
  await expect(getTeamAccessCodeForActor(TEAM_ID, ACTOR_ID)).resolves.toBe(ACCESS_CODE);

  expect(transactionMock).toHaveBeenCalledOnce();
  expect(teamFindFirstMock).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: TEAM_ID, deletedAt: null } }),
  );
});

test('a removed or demoted manager cannot read an access code through a stale replica', async () => {
  teamFindFirstMock.mockResolvedValueOnce({ accessCode: ACCESS_CODE, members: [] });
  await expect(getTeamAccessCodeForActor(TEAM_ID, ACTOR_ID)).resolves.toBeUndefined();

  teamFindFirstMock.mockResolvedValueOnce({
    accessCode: ACCESS_CODE,
    members: [{ role: 'team-member' }],
  });
  await expect(getTeamAccessCodeForActor(TEAM_ID, ACTOR_ID)).resolves.toBeUndefined();
});

test('global view-only demotion hides the code despite a manager membership', async () => {
  userFindFirstMock.mockResolvedValue({ role: 'view-only' });

  await expect(getTeamAccessCodeForActor(TEAM_ID, ACTOR_ID)).resolves.toBeUndefined();
  expect(teamFindFirstMock).not.toHaveBeenCalled();
});

test('an active administrator can read the current code without team membership', async () => {
  userFindFirstMock.mockResolvedValue({ role: 'admin' });
  teamFindFirstMock.mockResolvedValue({ accessCode: ACCESS_CODE, members: [] });

  await expect(getTeamAccessCodeForActor(TEAM_ID, ACTOR_ID)).resolves.toBe(ACCESS_CODE);
});

test('global view-only demotion cannot retrieve the code through a no-op update', async () => {
  userFindFirstMock.mockResolvedValue({ role: 'view-only' });

  await expect(updateTeam(TEAM_ID, {}, ACTOR_ID)).rejects.toThrow('TEAM_ACTOR_NOT_AUTHORIZED');
  expect(teamUpdateMock).not.toHaveBeenCalled();
});

test('current team managers can still update team settings', async () => {
  await expect(updateTeam(TEAM_ID, { name: 'Updated team' }, ACTOR_ID)).resolves.toMatchObject({
    id: TEAM_ID,
  });
  expect(teamUpdateMock).toHaveBeenCalledOnce();
});

test('a demoted team owner cannot delete the team', async () => {
  userFindFirstMock.mockResolvedValue({ role: 'view-only' });
  membershipFindFirstMock.mockResolvedValue({ role: 'team-owner' });

  await expect(deleteTeam(TEAM_ID, ACTOR_ID)).rejects.toThrow('TEAM_ACTOR_NOT_AUTHORIZED');
  expect(websiteFindManyMock).not.toHaveBeenCalled();
});

test('a deleted team owner cannot delete the team', async () => {
  userFindFirstMock.mockResolvedValue(null);
  membershipFindFirstMock.mockResolvedValue({ role: 'team-owner' });

  await expect(deleteTeam(TEAM_ID, ACTOR_ID)).rejects.toThrow('TEAM_ACTOR_NOT_AUTHORIZED');
  expect(websiteFindManyMock).not.toHaveBeenCalled();
});
