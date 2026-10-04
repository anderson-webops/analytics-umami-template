import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  canUpdateUser: vi.fn(),
  getUser: vi.fn(),
  hashPassword: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('@/lib/request', () => ({ parseRequest: mocks.parseRequest }));
vi.mock('@/lib/password', () => ({
  hashPassword: mocks.hashPassword,
  isAcceptableLoginPassword: () => true,
  isStrongPassword: () => true,
}));
vi.mock('@/permissions', () => ({
  canUpdateUser: mocks.canUpdateUser,
  canViewUser: vi.fn(),
  canDeleteUser: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  getUser: mocks.getUser,
  getUserByUsername: vi.fn(),
  isLastActiveAdminError: vi.fn(),
  isUserDeletionBlockedError: vi.fn(),
  updateUser: mocks.updateUser,
  deleteUser: vi.fn(),
}));

import { POST } from './route';

const adminId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: adminId, isAdmin: true } },
    body: { password: 'Replacement-password-123!' },
    error: undefined,
  });
  mocks.canUpdateUser.mockResolvedValue(true);
  mocks.getUser.mockResolvedValue({ id: adminId, username: 'admin' });
  mocks.hashPassword.mockResolvedValue('replacement-hash');
  mocks.updateUser.mockResolvedValue({ id: otherId });
});

test('an administrator cannot bypass current-password verification for their own account', async () => {
  const response = await POST(
    new Request(`http://localhost/api/users/${adminId}`, { method: 'POST' }),
    { params: Promise.resolve({ userId: adminId }) },
  );

  expect(response.status).toBe(403);
  expect(mocks.hashPassword).not.toHaveBeenCalled();
  expect(mocks.updateUser).not.toHaveBeenCalled();
});

test('an administrator can still reset another account password', async () => {
  mocks.getUser.mockResolvedValue({ id: otherId, username: 'other' });

  const response = await POST(
    new Request(`http://localhost/api/users/${otherId}`, { method: 'POST' }),
    { params: Promise.resolve({ userId: otherId }) },
  );

  expect(response.status).toBe(200);
  expect(mocks.hashPassword).toHaveBeenCalledWith('Replacement-password-123!');
  expect(mocks.updateUser).toHaveBeenCalledWith(otherId, { password: 'replacement-hash' }, adminId);
});
