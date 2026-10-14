import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  canCreateUser: vi.fn(),
  hashPassword: vi.fn(),
  createUser: vi.fn(),
}));

vi.mock('@/lib/request', () => ({ parseRequest: mocks.parseRequest }));
vi.mock('@/lib/password', () => ({
  hashPassword: mocks.hashPassword,
  isAcceptableLoginPassword: () => true,
  isStrongPassword: () => true,
}));
vi.mock('@/permissions', () => ({ canCreateUser: mocks.canCreateUser }));
vi.mock('@/queries/prisma', () => ({
  createUser: mocks.createUser,
}));

import { POST } from './route';

const administratorId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const session = {
  sessionGeneration: 3,
  passwordFingerprint: 'authenticated-fingerprint',
  mfaId: 'factor-1',
  authKey: 'auth:session-key',
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  mocks.parseRequest.mockResolvedValue({
    auth: { authType: 'session', user: { id: administratorId, isAdmin: true }, ...session },
    body: { id: userId, username: 'new-user', password: 'synthetic-password', role: 'user' },
  });
  mocks.canCreateUser.mockResolvedValue(true);
  mocks.hashPassword.mockResolvedValue('hashed-password');
  mocks.createUser.mockResolvedValue({ id: userId, username: 'new-user', role: 'user' });
});

test('creation uses the session observed before request-body work', async () => {
  const response = await POST(new Request('http://localhost/api/users', { method: 'POST' }));

  expect(response.status).toBe(200);
  expect(mocks.createUser).toHaveBeenCalledWith(
    { id: userId, username: 'new-user', password: 'hashed-password', role: 'user' },
    administratorId,
    session,
  );
});

test('creation returns unauthorized when the transaction rejects a revoked session', async () => {
  mocks.createUser.mockRejectedValue(new Error('ADMIN_AUTHORIZATION_CHANGED'));

  const response = await POST(new Request('http://localhost/api/users', { method: 'POST' }));

  expect(response.status).toBe(401);
  expect(mocks.createUser).toHaveBeenCalledOnce();
});

test('existing usernames are reported only after the session survives the transaction guard', async () => {
  mocks.createUser.mockRejectedValue(new Error('USER_ALREADY_EXISTS'));

  const response = await POST(new Request('http://localhost/api/users', { method: 'POST' }));

  expect(response.status).toBe(400);
  expect(mocks.createUser).toHaveBeenCalledOnce();
});
