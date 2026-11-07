import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RecoveryPreparationError } from '@/lib/login-recovery';
import { SessionRevokedError } from '@/queries/prisma/authorization';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getUser: vi.fn(),
  replacePasswordIfCurrent: vi.fn(),
  replacePasswordWithRecoveryIfCurrent: vi.fn(),
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
vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/queries/prisma/user', () => ({
  getUser: mocks.getUser,
  replacePasswordIfCurrent: mocks.replacePasswordIfCurrent,
  replacePasswordWithRecoveryIfCurrent: mocks.replacePasswordWithRecoveryIfCurrent,
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
  vi.stubEnv('CLOUD_MODE', '');
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  redis.enabled = false;
  mocks.parseRequest.mockResolvedValue({
    auth: {
      user: { id: 'user-1' },
      authType: 'session',
      passwordFingerprint: 'old-fingerprint',
      authKey: 'auth:old',
      mfaVerified: true,
      mfaId: 'enrollment-1',
      sessionGeneration: 0,
    },
    body: {
      currentPassword: 'old-password',
      newPassword: 'new-password',
      recoveryCode: `UR-${'A'.repeat(64)}`,
      saved: true,
    },
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
  mocks.replacePasswordWithRecoveryIfCurrent.mockResolvedValue({
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

afterEach(() => vi.unstubAllEnvs());

test('password verification stops before hash comparison when the attempt budget is exhausted', async () => {
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: false, retryAfter: 83 });

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));

  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('83');
  expect(mocks.reservePasswordVerificationAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.getUser).toHaveBeenCalledWith('user-1', { includePassword: true });
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.replacePasswordIfCurrent).not.toHaveBeenCalled();
  expect(mocks.replacePasswordWithRecoveryIfCurrent).not.toHaveBeenCalled();
});

test('password verification fails closed when the attempt budget is unavailable', async () => {
  mocks.reservePasswordVerificationAttempt.mockRejectedValue(new Error('database unavailable'));

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));

  expect(response.status).toBe(503);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.replacePasswordIfCurrent).not.toHaveBeenCalled();
  expect(mocks.replacePasswordWithRecoveryIfCurrent).not.toHaveBeenCalled();
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
  expect(mocks.replacePasswordWithRecoveryIfCurrent).toHaveBeenCalledWith(
    expect.objectContaining({ sessionGeneration: 0 }),
    'old-hash',
    'new-hash',
    `UR-${'A'.repeat(64)}`,
  );
  expect(mocks.replacePasswordIfCurrent).not.toHaveBeenCalled();

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
  mocks.replacePasswordWithRecoveryIfCurrent.mockRejectedValue(
    new Error('USER_CREDENTIALS_CHANGED'),
  );

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));

  expect(response.status).toBe(401);
  expect(mocks.replacePasswordWithRecoveryIfCurrent).toHaveBeenCalledOnce();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('local password replacement requires saved-copy proof for replacement recovery codes', async () => {
  const parsed = await mocks.parseRequest();
  parsed.body = { currentPassword: 'old-password', newPassword: 'new-password' };
  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));

  expect(response.status).toBe(400);
  expect(mocks.replacePasswordIfCurrent).not.toHaveBeenCalled();
  expect(mocks.replacePasswordWithRecoveryIfCurrent).not.toHaveBeenCalled();
  expect(mocks.hashPassword).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('stale recovery proof leaves the password and session unchanged', async () => {
  mocks.replacePasswordWithRecoveryIfCurrent.mockRejectedValue(new RecoveryPreparationError());
  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe('recovery-preparation-invalid');
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test('revoked current sessions cannot activate replacement credentials', async () => {
  mocks.replacePasswordWithRecoveryIfCurrent.mockRejectedValue(new SessionRevokedError());
  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));
  expect(response.status).toBe(401);
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('a newly required MFA policy denies password activation without issuing a session', async () => {
  mocks.replacePasswordWithRecoveryIfCurrent.mockRejectedValue(
    new Error('ENTITY_ACTOR_NOT_AUTHORIZED'),
  );
  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));
  expect(response.status).toBe(401);
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test.each(['api-key', 'share', 'enrollment'])(
  'local %s authority cannot change credentials',
  async type => {
    const parsed = await mocks.parseRequest();
    if (type === 'enrollment') parsed.auth.enrollmentOnly = true;
    else parsed.auth.authType = type;
    const response = await POST(
      new Request('http://localhost/api/me/password', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
    expect(mocks.checkPassword).not.toHaveBeenCalled();
    expect(mocks.replacePasswordWithRecoveryIfCurrent).not.toHaveBeenCalled();
  },
);

test('Cloud retains the existing password-change contract without local recovery', async () => {
  vi.stubEnv('CLOUD_MODE', '1');
  const parsed = await mocks.parseRequest();
  parsed.body = { currentPassword: 'old-password', newPassword: 'new-password' };
  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));
  expect(response.status).toBe(200);
  expect(mocks.replacePasswordIfCurrent).toHaveBeenCalledExactlyOnceWith(
    'user-1',
    'old-hash',
    'new-hash',
    0,
  );
  expect(mocks.replacePasswordWithRecoveryIfCurrent).not.toHaveBeenCalled();
});
