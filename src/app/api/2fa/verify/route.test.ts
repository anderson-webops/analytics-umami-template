import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBearerToken: vi.fn(),
  saveAuth: vi.fn(),
  parseSecureToken: vi.fn(),
  createSecureToken: vi.fn(),
  getUser: vi.fn(),
  getAllUserTeams: vi.fn(),
  findTwoFactorAuth: vi.fn(),
  findBackupCodes: vi.fn(),
  updateBackupCodes: vi.fn(),
  verifyBackupCode: vi.fn(),
  decryptSecret: vi.fn(),
  isTwoFactorConfigured: vi.fn(),
  reserveTwoFactorAttempt: vi.fn(),
  resetRateLimit: vi.fn(),
  consumeOtp: vi.fn(),
  verifyTotp: vi.fn(),
  secret: vi.fn(),
  hash: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getBearerToken: mocks.getBearerToken,
  saveAuth: mocks.saveAuth,
}));

vi.mock('@/lib/crypto', () => ({
  hash: mocks.hash,
  secret: mocks.secret,
}));

vi.mock('@/lib/jwt', () => ({
  createSecureToken: mocks.createSecureToken,
  parseSecureToken: mocks.parseSecureToken,
}));

vi.mock('@/queries/prisma', () => ({
  getAllUserTeams: mocks.getAllUserTeams,
  getUser: mocks.getUser,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: {
        findUnique: mocks.findTwoFactorAuth,
      },
      twoFactorBackupCode: {
        findMany: mocks.findBackupCodes,
        updateMany: mocks.updateBackupCodes,
      },
    },
  },
}));

vi.mock('@/lib/two-factor/backup-codes', () => ({
  verifyBackupCode: mocks.verifyBackupCode,
}));

vi.mock('@/lib/two-factor/crypto', () => ({
  decryptSecret: mocks.decryptSecret,
  getTwoFactorConfigurationError: () => ({
    code: 'two-factor-error-not-configured',
    message: 'TWO_FACTOR_ENCRYPTION_KEY is missing or invalid',
  }),
  isTwoFactorConfigured: mocks.isTwoFactorConfigured,
}));

vi.mock('@/lib/two-factor/rate-limit', () => ({
  reserveTwoFactorAttempt: mocks.reserveTwoFactorAttempt,
  resetRateLimit: mocks.resetRateLimit,
}));

vi.mock('@/lib/two-factor/replay-prevention', () => ({
  consumeOtp: mocks.consumeOtp,
}));

vi.mock('@/lib/two-factor/totp', () => ({
  verifyTotp: mocks.verifyTotp,
}));

vi.mock('@/lib/redis', () => ({
  default: {
    enabled: false,
  },
}));

import { POST } from './route';

beforeEach(() => {
  mocks.getBearerToken.mockReset();
  mocks.saveAuth.mockReset();
  mocks.parseSecureToken.mockReset();
  mocks.createSecureToken.mockReset();
  mocks.getUser.mockReset();
  mocks.getAllUserTeams.mockReset();
  mocks.findTwoFactorAuth.mockReset();
  mocks.findBackupCodes.mockReset();
  mocks.updateBackupCodes.mockReset();
  mocks.verifyBackupCode.mockReset();
  mocks.decryptSecret.mockReset();
  mocks.isTwoFactorConfigured.mockReset();
  mocks.reserveTwoFactorAttempt.mockReset();
  mocks.resetRateLimit.mockReset();
  mocks.consumeOtp.mockReset();
  mocks.verifyTotp.mockReset();
  mocks.secret.mockReset();
  mocks.hash.mockReset();

  mocks.getBearerToken.mockReturnValue('partial-token');
  mocks.secret.mockReturnValue('app-secret');
  mocks.hash.mockReturnValue('password-fingerprint');
  mocks.parseSecureToken.mockReturnValue({
    type: 'partial-auth',
    userId: 'user-1',
    pwd: 'password-fingerprint',
    sessionGeneration: 0,
  });
  mocks.getUser.mockResolvedValue({
    id: 'user-1',
    username: 'alice',
    password: 'hashed-password',
    sessionGeneration: 0,
    role: 'admin',
    createdAt: new Date('2026-07-23T00:00:00.000Z'),
  });
  mocks.getAllUserTeams.mockResolvedValue([]);
  mocks.findTwoFactorAuth.mockResolvedValue({
    id: 'enrollment-1',
    userId: 'user-1',
    isEnabled: true,
    secret: 'encrypted',
  });
  mocks.createSecureToken.mockReturnValue('full-auth-token');
  mocks.decryptSecret.mockReturnValue('plain-secret');
  mocks.isTwoFactorConfigured.mockReturnValue(true);
  mocks.reserveTwoFactorAttempt.mockResolvedValue({ allowed: true });
  mocks.resetRateLimit.mockResolvedValue(undefined);
  mocks.consumeOtp.mockResolvedValue(true);
  mocks.verifyTotp.mockResolvedValue(true);
  mocks.findBackupCodes.mockResolvedValue([]);
  mocks.updateBackupCodes.mockResolvedValue({ count: 0 });
  mocks.verifyBackupCode.mockResolvedValue(null);
});

test('POST accepts a token-only payload and completes 2FA verification', async () => {
  const response = await POST(
    new Request('http://localhost/api/2fa/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer partial-token',
      },
      body: JSON.stringify({ token: '123456' }),
    }),
  );

  expect(mocks.verifyTotp).toHaveBeenCalledWith('123456', 'plain-secret');
  expect(mocks.reserveTwoFactorAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.reserveTwoFactorAttempt.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.verifyTotp.mock.invocationCallOrder[0],
  );
  expect(mocks.consumeOtp).toHaveBeenCalledWith('user-1', '123456');
  expect(mocks.resetRateLimit).toHaveBeenCalledWith('user-1');
  expect(mocks.createSecureToken).toHaveBeenCalledWith(
    {
      userId: 'user-1',
      role: 'admin',
      pwd: 'password-fingerprint',
      sessionGeneration: 0,
      mfa: true,
      mfaId: 'enrollment-1',
    },
    'app-secret',
    expect.any(Object),
  );
  await expect(response.json()).resolves.toMatchObject({
    token: 'full-auth-token',
    user: {
      id: 'user-1',
      username: 'alice',
    },
  });
  expect(response.status).toBe(200);
});

test('POST rejects a partial token issued before factor reset without checking a code', async () => {
  mocks.getUser.mockResolvedValue({
    id: 'user-1',
    password: 'hashed-password',
    sessionGeneration: 1,
  });

  const response = await POST(
    new Request('http://localhost/api/2fa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer partial-token' },
      body: JSON.stringify({ token: '123456' }),
    }),
  );

  expect(response.status).toBe(401);
  expect(mocks.findTwoFactorAuth).not.toHaveBeenCalled();
  expect(mocks.verifyTotp).not.toHaveBeenCalled();
});

test('POST rejects a valid TOTP already consumed by a concurrent request', async () => {
  mocks.consumeOtp.mockResolvedValue(false);

  const response = await POST(
    new Request('http://localhost/api/2fa/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer partial-token',
      },
      body: JSON.stringify({ token: '123456' }),
    }),
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'two-factor-error-code-used' },
  });
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  expect(mocks.resetRateLimit).not.toHaveBeenCalled();
  expect(mocks.reserveTwoFactorAttempt).toHaveBeenCalledWith('user-1');
});

test('POST denies exhausted attempts before checking a TOTP', async () => {
  const lockedUntil = new Date('2026-10-03T12:15:00.000Z');
  mocks.reserveTwoFactorAttempt.mockResolvedValue({ allowed: false, lockedUntil });

  const response = await POST(
    new Request('http://localhost/api/2fa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer partial-token' },
      body: JSON.stringify({ token: '123456' }),
    }),
  );

  expect(response.status).toBe(429);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'two-factor-error-too-many-attempts', lockedUntil: lockedUntil.toISOString() },
  });
  expect(mocks.verifyTotp).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('POST bounds concurrent TOTP checks to reserved attempts', async () => {
  let reserved = 0;
  mocks.reserveTwoFactorAttempt.mockImplementation(async () => ({ allowed: ++reserved <= 5 }));
  mocks.verifyTotp.mockResolvedValue(false);

  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      POST(
        new Request('http://localhost/api/2fa/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer partial-token' },
          body: JSON.stringify({ token: '123456' }),
        }),
      ),
    ),
  );

  expect(responses.filter(response => response.status === 400)).toHaveLength(5);
  expect(responses.filter(response => response.status === 429)).toHaveLength(7);
  expect(mocks.verifyTotp).toHaveBeenCalledTimes(5);
});

test('POST returns a configuration error when the encryption key is missing', async () => {
  mocks.isTwoFactorConfigured.mockReturnValue(false);

  const response = await POST(
    new Request('http://localhost/api/2fa/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer partial-token',
      },
      body: JSON.stringify({ token: '123456' }),
    }),
  );

  expect(mocks.findTwoFactorAuth).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-not-configured',
    },
  });
  expect(response.status).toBe(503);
});
