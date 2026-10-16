import { beforeEach, expect, test, vi } from 'vitest';
import { ROLES } from '@/lib/constants';
import { parseRequest } from '@/lib/request';
import { joinTeamByAccessCode } from '@/queries/prisma';
import { POST } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/queries/prisma', () => ({ joinTeamByAccessCode: vi.fn() }));

const parseRequestMock = vi.mocked(parseRequest);
const joinTeamMock = vi.mocked(joinTeamByAccessCode);
const accessCode = 'team_abcdefghijklmnop';

beforeEach(() => {
  vi.clearAllMocks();
  parseRequestMock.mockResolvedValue({
    auth: { user: { id: 'user-1', role: ROLES.user, isAdmin: false } },
    body: { accessCode },
  });
  joinTeamMock.mockResolvedValue({ id: 'membership-1' } as any);
});

test('a global view-only session cannot attempt to join a team', async () => {
  parseRequestMock.mockResolvedValueOnce({
    auth: { user: { id: 'user-1', role: ROLES.viewOnly, isAdmin: false } },
    body: { accessCode },
  });

  const response = await POST(new Request('http://localhost/api/teams/join', { method: 'POST' }));

  expect(response.status).toBe(401);
  expect(joinTeamMock).not.toHaveBeenCalled();
});

test('a role change during team joining is rejected', async () => {
  joinTeamMock.mockRejectedValueOnce(new Error('TEAM_ACTOR_NOT_AUTHORIZED'));

  const response = await POST(new Request('http://localhost/api/teams/join', { method: 'POST' }));

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    error: { message: 'Your team-join permission changed.' },
  });
});

test.each([
  [ROLES.user, false],
  [ROLES.admin, true],
])('an active %s account can still join a team', async (role, isAdmin) => {
  parseRequestMock.mockResolvedValueOnce({
    auth: { user: { id: 'user-1', role, isAdmin } },
    body: { accessCode },
  });

  const response = await POST(new Request('http://localhost/api/teams/join', { method: 'POST' }));

  expect(response.status).toBe(200);
  expect(joinTeamMock).toHaveBeenCalledWith(
    'user-1',
    accessCode,
    expect.objectContaining({ user: expect.objectContaining({ id: 'user-1', role }) }),
  );
});
