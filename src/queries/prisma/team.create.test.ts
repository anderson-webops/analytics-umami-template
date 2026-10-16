import { beforeEach, expect, test, vi } from 'vitest';
import { ROLES } from '@/lib/constants';
import { assertCurrentActorAuth } from './authorization';
import { createTeam } from './team';

const {
  transactionMock,
  queryRawMock,
  userFindFirstMock,
  teamCountMock,
  teamCreateMock,
  teamUserCreateMock,
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  queryRawMock: vi.fn(),
  userFindFirstMock: vi.fn(),
  teamCountMock: vi.fn(),
  teamCreateMock: vi.fn(),
  teamUserCreateMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: { transaction: transactionMock },
}));

const ownerId = '1085fb06-4dd8-4fc8-b94a-c79146fa8947';
const teamId = '3979e857-a987-4795-9380-12024a4440a9';
const team = { id: teamId, name: 'Analytics' };
const ownerAuth = {
  authType: 'session' as const,
  user: { id: ownerId, username: 'owner', role: ROLES.user, isAdmin: false },
};

vi.mock('./authorization', async importOriginal => ({
  ...(await importOriginal<typeof import('./authorization')>()),
  assertCurrentActorAuth: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  queryRawMock.mockResolvedValue([]);
  userFindFirstMock.mockResolvedValue({ role: ROLES.user });
  teamCountMock.mockResolvedValue(9);
  teamCreateMock.mockResolvedValue(team);
  teamUserCreateMock.mockResolvedValue({ id: 'membership-1' });
  transactionMock.mockImplementation(async callback =>
    callback({
      $queryRaw: queryRawMock,
      user: { findFirst: userFindFirstMock },
      team: { count: teamCountMock, create: teamCreateMock },
      teamUser: { create: teamUserCreateMock },
    }),
  );
});

test('the finite team quota is checked in the serializable insertion transaction', async () => {
  await expect(createTeam(team, ownerId, ownerId, 10, ownerAuth)).resolves.toEqual(team);

  expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'Serializable',
  });
  expect(teamCountMock).toHaveBeenCalledWith({
    where: {
      deletedAt: null,
      members: { some: { userId: ownerId, role: ROLES.teamOwner } },
    },
  });
  expect(teamCountMock.mock.invocationCallOrder[0]).toBeLessThan(
    teamCreateMock.mock.invocationCallOrder[0],
  );
});

test('a retry that observes a filled quota rejects before inserting', async () => {
  teamCountMock.mockResolvedValue(10);

  await expect(createTeam(team, ownerId, ownerId, 10, ownerAuth)).rejects.toThrow(
    'TEAM_LIMIT_REACHED',
  );
  expect(teamCreateMock).not.toHaveBeenCalled();
  expect(teamUserCreateMock).not.toHaveBeenCalled();
});

test('a serialization conflict rechecks the quota before retry insertion', async () => {
  teamCountMock.mockResolvedValueOnce(9).mockResolvedValueOnce(10);
  transactionMock.mockImplementation(async callback => {
    const result = await callback({
      $queryRaw: queryRawMock,
      user: { findFirst: userFindFirstMock },
      team: { count: teamCountMock, create: teamCreateMock },
      teamUser: { create: teamUserCreateMock },
    });

    if (teamCountMock.mock.calls.length === 1) {
      throw { code: 'P2034' };
    }

    return result;
  });

  await expect(createTeam(team, ownerId, ownerId, 10, ownerAuth)).rejects.toThrow(
    'TEAM_LIMIT_REACHED',
  );
  expect(teamCountMock).toHaveBeenCalledTimes(2);
  expect(teamCreateMock).toHaveBeenCalledTimes(1);
});

test('unlimited and self-hosted team creation do not count owned teams', async () => {
  await expect(createTeam(team, ownerId, ownerId, null, ownerAuth)).resolves.toEqual(team);
  expect(teamCountMock).not.toHaveBeenCalled();
});

test('an invalid finite quota fails closed before starting a transaction', async () => {
  await expect(createTeam(team, ownerId, ownerId, -1, ownerAuth)).rejects.toThrow(
    'TEAM_LIMIT_INVALID',
  );
  expect(transactionMock).not.toHaveBeenCalled();
});

test('delegated team creation locks only the acting administrator, not the owner', async () => {
  const administratorId = '6983ec3f-799f-4be7-b536-a803879054af';
  const administratorAuth = {
    authType: 'session' as const,
    user: { id: administratorId, username: 'admin', role: ROLES.admin, isAdmin: true },
  };
  userFindFirstMock
    .mockResolvedValueOnce({ role: ROLES.admin })
    .mockResolvedValueOnce({ role: ROLES.user });

  await expect(
    createTeam(team, ownerId, administratorId, null, administratorAuth),
  ).resolves.toEqual(team);

  expect(assertCurrentActorAuth).toHaveBeenCalledWith(
    expect.anything(),
    administratorId,
    administratorAuth,
    'TEAM_ACTOR_NOT_AUTHORIZED',
  );
  expect(vi.mocked(assertCurrentActorAuth).mock.invocationCallOrder[0]).toBeLessThan(
    userFindFirstMock.mock.invocationCallOrder[0],
  );
});
