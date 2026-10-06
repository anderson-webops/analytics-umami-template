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
  reservePasswordVerificationAttempt: vi.fn(),
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
vi.mock('@/lib/password-verification-rate-limit', () => ({
  reservePasswordVerificationAttempt: mocks.reservePasswordVerificationAttempt,
}));
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
    auth: {
      user: { id: 'user-1' },
      authKey: 'auth:old',
      mfaVerified: true,
      mfaId: 'enrollment-1',
      sessionGeneration: 0,
    },
    body: { currentPassword: 'old-password', newPassword: 'new-password' },
    error: undefined,
  });
  mocks.getUser.mockResolvedValue({ id: 'user-1', password: 'old-hash' });
  mocks.checkPassword.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  mocks.hashPassword.mockResolvedValue('new-hash');
  mocks.replacePasswordIfCurrent.mockResolvedValue({
    id: 'user-1',
    role: 'user',
    sessionGeneration: 1,
  });
  mocks.hash.mockReturnValue('new-fingerprint');
  mocks.secret.mockReturnValue('app-secret');
  mocks.createSecureToken.mockReturnValue('new-session');
  mocks.saveAuth.mockResolvedValue('new-session');
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: true, retryAfter: 0 });
});

test('password verification stops before hash comparison when the attempt budget is exhausted', async () => {
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: false, retryAfter: 83 });

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));

  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('83');
  expect(mocks.reservePasswordVerificationAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.getUser).toHaveBeenCalledWith('user-1', { includePassword: true });
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.replacePasswordIfCurrent).not.toHaveBeenCalled();
});

test('password verification fails closed when the attempt budget is unavailable', async () => {
  mocks.reservePasswordVerificationAttempt.mockRejectedValue(new Error('database unavailable'));

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));

  expect(response.status).toBe(503);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.replacePasswordIfCurrent).not.toHaveBeenCalled();
});

test.each([false, true])('password change preserves verified 2FA (Redis %s)', async enabled => {
  redis.enabled = enabled;

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));
  const sessionData = {
    userId: 'user-1',
    role: 'user',
    pwd: 'new-fingerprint',
    sessionGeneration: 1,
    mfa: true,
    mfaId: 'enrollment-1',
  };

  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('new-session');
  expect(mocks.replacePasswordIfCurrent).toHaveBeenCalledWith('user-1', 'old-hash', 'new-hash', 0);

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

test('password change does not reissue a session after a concurrent factor reset', async () => {
  mocks.replacePasswordIfCurrent.mockRejectedValue(new Error('USER_CREDENTIALS_CHANGED'));

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));

  expect(response.status).toBe(401);
  expect(mocks.replacePasswordIfCurrent).toHaveBeenCalledWith('user-1', 'old-hash', 'new-hash', 0);
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});
