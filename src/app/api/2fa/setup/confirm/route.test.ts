import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => {
  const tx = {
    user: {
      updateMany: vi.fn(),
    },
    twoFactorAuth: {
      updateMany: vi.fn(),
    },
    twoFactorBackupCode: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    apiKey: {
      deleteMany: vi.fn(),
    },
  };

  return {
    parseRequest: vi.fn(),
    findUnique: vi.fn(),
    transaction: vi.fn(),
    tx,
    generateBackupCodes: vi.fn(),
    decryptSecret: vi.fn(),
    isTwoFactorConfigured: vi.fn(),
    reserveTwoFactorAttempt: vi.fn(),
    resetRateLimit: vi.fn(),
    consumeOtp: vi.fn(),
    verifyTotp: vi.fn(),
    getUser: vi.fn(),
    hash: vi.fn(),
    secret: vi.fn(),
    createSecureToken: vi.fn(),
  };
});

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/queries/prisma/user', () => ({
  getUser: mocks.getUser,
}));

vi.mock('@/lib/crypto', () => ({
  hash: mocks.hash,
  secret: mocks.secret,
}));

vi.mock('@/lib/jwt', () => ({
  createSecureToken: mocks.createSecureToken,
}));

vi.mock('@/lib/redis', () => ({
  default: { enabled: false },
}));

vi.mock('@/lib/auth', () => ({
  saveAuth: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: {
        findUnique: mocks.findUnique,
      },
    },
    transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/two-factor/backup-codes', () => ({
  generateBackupCodes: mocks.generateBackupCodes,
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

beforeEach(() => {
  vi.stubEnv('CLOUD_MODE', '0');
  vi.stubEnv('DISABLE_LOGIN', '0');
  mocks.parseRequest.mockReset();
  mocks.findUnique.mockReset();
  mocks.transaction.mockReset();
  mocks.tx.user.updateMany.mockReset();
  mocks.tx.twoFactorAuth.updateMany.mockReset();
  mocks.tx.twoFactorBackupCode.deleteMany.mockReset();
  mocks.tx.twoFactorBackupCode.createMany.mockReset();
  mocks.tx.apiKey.deleteMany.mockReset();
  mocks.generateBackupCodes.mockReset();
  mocks.decryptSecret.mockReset();
  mocks.isTwoFactorConfigured.mockReset();
  mocks.reserveTwoFactorAttempt.mockReset();
  mocks.resetRateLimit.mockReset();
  mocks.consumeOtp.mockReset();
  mocks.verifyTotp.mockReset();
  mocks.getUser.mockReset();
  mocks.hash.mockReset();
  mocks.secret.mockReset();
  mocks.createSecureToken.mockReset();

  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1', role: 'user' }, sessionGeneration: 0 },
    body: { token: '123456' },
    error: undefined,
  });
  mocks.findUnique.mockResolvedValue({
    id: 'enrollment-1',
    userId: 'user-1',
    isEnabled: false,
    secret: 'encrypted',
  });
  mocks.transaction.mockImplementation(async callback => callback(mocks.tx));
  mocks.generateBackupCodes.mockResolvedValue({
    plaintext: ['code-1', 'code-2'],
    hashed: ['hash-1', 'hash-2'],
  });
  mocks.decryptSecret.mockReturnValue('plain-secret');
  mocks.isTwoFactorConfigured.mockReturnValue(true);
  mocks.reserveTwoFactorAttempt.mockResolvedValue({ allowed: true });
  mocks.resetRateLimit.mockResolvedValue(undefined);
  mocks.consumeOtp.mockResolvedValue(true);
  mocks.verifyTotp.mockResolvedValue(true);
  mocks.tx.twoFactorAuth.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.user.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.twoFactorBackupCode.deleteMany.mockResolvedValue(undefined);
  mocks.tx.twoFactorBackupCode.createMany.mockResolvedValue(undefined);
  mocks.getUser.mockResolvedValue({
    id: 'user-1',
    role: 'user',
    password: 'hashed-password',
    sessionGeneration: 1,
  });
  mocks.hash.mockReturnValue('password-fingerprint');
  mocks.secret.mockReturnValue('app-secret');
  mocks.createSecureToken.mockReturnValue('verified-session-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('disabled login cannot elevate a pending password-login enrollment session', async () => {
  vi.stubEnv('DISABLE_LOGIN', '1');
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1', role: 'user' }, sessionGeneration: 0, enrollmentOnly: true },
    body: { token: '123456' },
    error: undefined,
  });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'login-disabled' } });
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(mocks.findUnique).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('disabled login still permits existing full sessions to enroll 2FA', async () => {
  vi.stubEnv('DISABLE_LOGIN', '1');

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(response.status).toBe(200);
  expect(mocks.createSecureToken).toHaveBeenCalled();
});

test('POST confirms setup, enables 2FA, stores backup codes, and resets the rate limit', async () => {
  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(mocks.reserveTwoFactorAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.decryptSecret).toHaveBeenCalledWith('encrypted');
  expect(mocks.verifyTotp).toHaveBeenCalledWith('123456', 'plain-secret');
  expect(mocks.tx.user.updateMany).toHaveBeenCalledWith({
    where: { id: 'user-1', deletedAt: null, sessionGeneration: 0 },
    data: { sessionGeneration: { increment: 1 } },
  });
  expect(mocks.tx.twoFactorAuth.updateMany).toHaveBeenCalledWith({
    where: {
      id: 'enrollment-1',
      userId: 'user-1',
      secret: 'encrypted',
      isEnabled: false,
    },
    data: { isEnabled: true },
  });
  expect(mocks.tx.twoFactorBackupCode.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'user-1' },
  });
  expect(mocks.tx.twoFactorBackupCode.createMany).toHaveBeenCalledWith({
    data: [
      { userId: 'user-1', codeHash: 'hash-1' },
      { userId: 'user-1', codeHash: 'hash-2' },
    ],
  });
  expect(mocks.consumeOtp).toHaveBeenCalledWith('user-1', '123456', mocks.tx);
  expect(mocks.tx.apiKey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  expect(mocks.resetRateLimit).toHaveBeenCalledWith('user-1');
  expect(mocks.createSecureToken).toHaveBeenCalledWith(
    {
      userId: 'user-1',
      role: 'user',
      pwd: 'password-fingerprint',
      sessionGeneration: 1,
      mfa: true,
      mfaId: 'enrollment-1',
    },
    'app-secret',
    expect.any(Object),
  );
  expect(response.headers.get('set-cookie')).toContain('verified-session-token');
  await expect(response.json()).resolves.toEqual({
    backupCodes: ['code-1', 'code-2'],
  });
  expect(response.status).toBe(200);
});

test('POST cannot issue a post-reset session from a pre-reset confirmation request', async () => {
  mocks.getUser.mockResolvedValue({
    id: 'user-1',
    role: 'user',
    password: 'hashed-password',
    sessionGeneration: 2,
  });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('POST rejects a stale session before enabling a factor or revoking keys', async () => {
  mocks.tx.user.updateMany.mockResolvedValue({ count: 0 });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'credentials-changed' } });
  expect(mocks.tx.twoFactorAuth.updateMany).not.toHaveBeenCalled();
  expect(mocks.tx.apiKey.deleteMany).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('POST does not adopt a new administrator role after confirmation', async () => {
  mocks.getUser.mockResolvedValue({
    id: 'user-1',
    role: 'admin',
    password: 'hashed-password',
    sessionGeneration: 1,
  });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('POST leaves setup pending when another request consumes the TOTP first', async () => {
  mocks.consumeOtp.mockResolvedValue(false);

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'two-factor-error-code-used' },
  });
  expect(mocks.tx.twoFactorAuth.updateMany).toHaveBeenCalled();
  expect(mocks.resetRateLimit).not.toHaveBeenCalled();
});

test('POST rejects a replaced or completed setup before consuming an OTP or issuing a session', async () => {
  mocks.tx.twoFactorAuth.updateMany.mockResolvedValue({ count: 0 });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'two-factor-error-setup-changed' },
  });
  expect(mocks.consumeOtp).not.toHaveBeenCalled();
  expect(mocks.tx.twoFactorBackupCode.deleteMany).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('POST reports a configuration error when the encryption key is missing', async () => {
  mocks.isTwoFactorConfigured.mockReturnValue(false);

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(mocks.reserveTwoFactorAttempt).not.toHaveBeenCalled();
  expect(mocks.decryptSecret).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-not-configured',
    },
  });
  expect(response.status).toBe(503);
});

test('POST reserves an attempt and skips writes when the token is invalid', async () => {
  mocks.verifyTotp.mockResolvedValue(false);

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/confirm', { method: 'POST' }),
  );

  expect(mocks.reserveTwoFactorAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.resetRateLimit).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-invalid-code',
    },
  });
  expect(response.status).toBe(400);
});
