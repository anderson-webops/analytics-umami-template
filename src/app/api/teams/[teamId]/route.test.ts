import { beforeEach, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import { canViewTeam } from '@/permissions';
import { getTeam, getTeamAccessCodeForActor } from '@/queries/prisma';
import { GET } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canDeleteTeam: vi.fn(),
  canUpdateTeam: vi.fn(),
  canViewTeam: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  deleteTeam: vi.fn(),
  getTeam: vi.fn(),
  getTeamAccessCodeForActor: vi.fn(),
  updateTeam: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const canViewTeamMock = vi.mocked(canViewTeam);
const getTeamMock = vi.mocked(getTeam);
const getTeamAccessCodeForActorMock = vi.mocked(getTeamAccessCodeForActor);
const team = {
  id: 'team-1',
  name: 'Team',
  accessCode: 'team_privatecode123',
  members: [],
};

async function readTeam(authType: 'session' | 'api-key') {
  parseRequestMock.mockResolvedValue({
    auth: {
      user: { id: 'user-1', username: 'user', role: 'user', isAdmin: false },
      authType,
    },
  });

  const response = await GET(new Request('http://localhost/api/teams/team-1'), {
    params: Promise.resolve({ teamId: 'team-1' }),
  });

  expect(response.status).toBe(200);
  return response.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  canViewTeamMock.mockResolvedValue(true);
  getTeamMock.mockResolvedValue(team as any);
  getTeamAccessCodeForActorMock.mockResolvedValue(undefined);
});

test.each(['team-member', 'team-view-only'])(
  '%s can view team details but not the reusable access code',
  async () => {
    const response = await readTeam('session');

    expect(response.name).toBe(team.name);
    expect(response).not.toHaveProperty('accessCode');
    expect(getTeamAccessCodeForActorMock).toHaveBeenCalledWith('team-1', 'user-1');
  },
);

test('interactive team managers retain access to their access code', async () => {
  getTeamAccessCodeForActorMock.mockResolvedValue(team.accessCode);

  const response = await readTeam('session');

  expect(response.accessCode).toBe(team.accessCode);
});

test('API-key reads do not expose the access code to non-managing accounts', async () => {
  const response = await readTeam('api-key');

  expect(response.name).toBe(team.name);
  expect(response).not.toHaveProperty('accessCode');
});

test('API-key reads follow team management permissions', async () => {
  getTeamAccessCodeForActorMock.mockResolvedValue(team.accessCode);

  const response = await readTeam('api-key');

  expect(response.accessCode).toBe(team.accessCode);
});

test('non-members cannot view the team or its access code', async () => {
  canViewTeamMock.mockResolvedValue(false);

  const response = await GET(new Request('http://localhost/api/teams/team-1'), {
    params: Promise.resolve({ teamId: 'team-1' }),
  });

  expect(response.status).toBe(401);
  expect(getTeamMock).not.toHaveBeenCalled();
  expect(getTeamAccessCodeForActorMock).not.toHaveBeenCalled();
});
