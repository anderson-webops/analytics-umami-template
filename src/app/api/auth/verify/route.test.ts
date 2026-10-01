import { beforeEach, expect, test, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getAllUserTeams: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/queries/prisma', () => ({
  getAllUserTeams: mocks.getAllUserTeams,
}));

beforeEach(() => {
  mocks.parseRequest.mockReset();
  mocks.getAllUserTeams.mockReset();
  mocks.getAllUserTeams.mockResolvedValue([{ id: 'private-team', name: 'Private team' }]);
});

test('POST with an enrollment-only session omits team memberships', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1', username: 'alice' }, enrollmentOnly: true },
    error: undefined,
  });

  const response = await POST(new Request('http://localhost/api/auth/verify', { method: 'POST' }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ teams: [] });
  expect(mocks.getAllUserTeams).not.toHaveBeenCalled();
});

test('POST with a verified session retains its normal team memberships', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1', username: 'alice' }, enrollmentOnly: false },
    error: undefined,
  });

  const response = await POST(new Request('http://localhost/api/auth/verify', { method: 'POST' }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    teams: [{ id: 'private-team', name: 'Private team' }],
  });
  expect(mocks.getAllUserTeams).toHaveBeenCalledWith('user-1');
});
