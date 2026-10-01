import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getUser: vi.fn(),
  replacePasswordIfCurrent: vi.fn(),
  checkPassword: vi.fn(),
  hashPassword: vi.fn(),
  hash: vi.fn(),
  secret: vi.fn(),
  createSecureToken: vi.fn(),
  saveAuth: vi.fn(),
  deleteAuthKey: vi.fn(),
}));

vi.mock('@/lib/request', () => ({ parseRequest: mocks.parseRequest }));
vi.mock('@/queries/prisma/user', () => ({
  getUser: mocks.getUser,
  replacePasswordIfCurrent: mocks.replacePasswordIfCurrent,
}));
vi.mock('@/lib/password', () => ({
  checkPassword: mocks.checkPassword,
  hashPassword: mocks.hashPassword,
  isAcceptableLoginPassword: () => true,
  isStrongPassword: () => true,
}));
vi.mock('@/lib/crypto', () => ({ hash: mocks.hash, secret: mocks.secret }));
vi.mock('@/lib/jwt', () => ({ createSecureToken: mocks.createSecureToken }));
vi.mock('@/lib/auth', () => ({ saveAuth: mocks.saveAuth }));
vi.mock('@/lib/redis', () => ({
  default: { enabled: false, client: { del: mocks.deleteAuthKey } },
}));

import redis from '@/lib/redis';
import { POST } from './route';

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  redis.enabled = false;
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1' }, authKey: 'auth:old', mfaVerified: true, mfaId: 'enrollment-1' },
    body: { currentPassword: 'old-password', newPassword: 'new-password' },
    error: undefined,
  });
  mocks.getUser.mockResolvedValue({ id: 'user-1', password: 'old-hash' });
  mocks.checkPassword.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  mocks.hashPassword.mockResolvedValue('new-hash');
  mocks.replacePasswordIfCurrent.mockResolvedValue({ id: 'user-1', role: 'user' });
  mocks.hash.mockReturnValue('new-fingerprint');
  mocks.secret.mockReturnValue('app-secret');
  mocks.createSecureToken.mockReturnValue('new-session');
  mocks.saveAuth.mockResolvedValue('new-session');
});

test.each([false, true])('password change preserves verified 2FA (Redis %s)', async enabled => {
  redis.enabled = enabled;

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));
  const sessionData = {
    userId: 'user-1',
    role: 'user',
    pwd: 'new-fingerprint',
    mfa: true,
    mfaId: 'enrollment-1',
  };

  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('new-session');

  if (enabled) {
    expect(mocks.deleteAuthKey).toHaveBeenCalledWith('auth:old');
    expect(mocks.saveAuth).toHaveBeenCalledWith(sessionData, expect.any(Number));
  } else {
    expect(mocks.createSecureToken).toHaveBeenCalledWith(
      sessionData,
      'app-secret',
      expect.any(Object),
    );
  }
});
