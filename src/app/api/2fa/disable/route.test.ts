import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  isTwoFactorConfigured: vi.fn(),
  getTwoFactorRequirement: vi.fn(),
  checkPassword: vi.fn(),
  getUser: vi.fn(),
  findTwoFactorAuth: vi.fn(),
  reserveTwoFactorAttempt: vi.fn(),
  verifyTotp: vi.fn(),
  reservePasswordVerificationAttempt: vi.fn(),
  transaction: vi.fn(),
  userUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  deleteTwoFactorAuth: vi.fn(),
  deleteBackupCodes: vi.fn(),
  deleteRateLimit: vi.fn(),
  consumeOtp: vi.fn(),
  saveAuth: vi.fn(),
  createSecureToken: vi.fn(),
  hash: vi.fn(),
  secret: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ saveAuth: mocks.saveAuth }));

vi.mock('@/lib/crypto', () => ({ hash: mocks.hash, secret: mocks.secret }));

vi.mock('@/lib/jwt', () => ({ createSecureToken: mocks.createSecureToken }));

vi.mock('@/lib/redis', () => ({ default: { enabled: false } }));

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: { findUnique: mocks.findTwoFactorAuth },
    },
    transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/two-factor/crypto', () => ({
  decryptSecret: vi.fn(),
  getTwoFactorConfigurationError: () => ({
    code: 'two-factor-error-not-configured',
    message: 'TWO_FACTOR_ENCRYPTION_KEY is missing or invalid',
  }),
  isTwoFactorConfigured: mocks.isTwoFactorConfigured,
}));

vi.mock('@/lib/two-factor/rate-limit', () => ({
  reserveTwoFactorAttempt: mocks.reserveTwoFactorAttempt,
}));

vi.mock('@/lib/two-factor/requirement', () => ({
  getTwoFactorRequirement: mocks.getTwoFactorRequirement,
}));

vi.mock('@/lib/two-factor/replay-prevention', () => ({
  consumeOtp: mocks.consumeOtp,
}));

vi.mock('@/lib/two-factor/totp', () => ({
  verifyTotp: mocks.verifyTotp,
}));

vi.mock('@/lib/password', () => ({
  checkPassword: mocks.checkPassword,
}));

vi.mock('@/lib/password-verification-rate-limit', () => ({
  reservePasswordVerificationAttempt: mocks.reservePasswordVerificationAttempt,
}));

vi.mock('@/queries/prisma/user', () => ({
  getUser: mocks.getUser,
}));

import { POST } from './route';

beforeEach(() => {
  mocks.parseRequest.mockReset();
  mocks.isTwoFactorConfigured.mockReset();
  mocks.getTwoFactorRequirement.mockReset();
  mocks.checkPassword.mockReset();
  mocks.getUser.mockReset();
  mocks.findTwoFactorAuth.mockReset();
  mocks.reserveTwoFactorAttempt.mockReset();
  mocks.verifyTotp.mockReset();
  mocks.reservePasswordVerificationAttempt.mockReset();
  mocks.transaction.mockReset();
  mocks.userUpdateMany.mockReset();
  mocks.userFindUnique.mockReset();
  mocks.deleteTwoFactorAuth.mockReset();
  mocks.deleteBackupCodes.mockReset();
  mocks.deleteRateLimit.mockReset();
  mocks.consumeOtp.mockReset();
  mocks.saveAuth.mockReset();
  mocks.createSecureToken.mockReset();
  mocks.hash.mockReset();
  mocks.secret.mockReset();

  mocks.isTwoFactorConfigured.mockReturnValue(true);
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: true, retryAfter: 0 });
  mocks.transaction.mockImplementation(async callback =>
    callback({
      user: { updateMany: mocks.userUpdateMany, findUnique: mocks.userFindUnique },
      twoFactorAuth: { deleteMany: mocks.deleteTwoFactorAuth },
      twoFactorBackupCode: { deleteMany: mocks.deleteBackupCodes },
      twoFactorRateLimit: { deleteMany: mocks.deleteRateLimit },
    }),
  );
  mocks.userUpdateMany.mockResolvedValue({ count: 1 });
  mocks.userFindUnique.mockResolvedValue({
    role: 'user',
    password: 'hashed-password',
    sessionGeneration: 1,
  });
  mocks.deleteTwoFactorAuth.mockResolvedValue({ count: 1 });
  mocks.consumeOtp.mockResolvedValue(true);
  mocks.deleteRateLimit.mockResolvedValue({ count: 1 });
  mocks.hash.mockReturnValue('password-fingerprint');
  mocks.createSecureToken.mockReturnValue('fresh-session');
});

test('POST rotates the session generation with factor deletion and returns only a fresh session', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1' } },
    body: { password: 'password', token: '123456' },
    error: undefined,
  });
  mocks.getTwoFactorRequirement.mockResolvedValue({ reason: null });
  mocks.getUser.mockResolvedValue({ password: 'hashed-password' });
  mocks.checkPassword.mockResolvedValue(true);
  mocks.findTwoFactorAuth.mockResolvedValue({
    id: 'factor-1',
    isEnabled: true,
    secret: 'encrypted',
  });
  mocks.reserveTwoFactorAttempt.mockResolvedValue({ allowed: true });
  mocks.verifyTotp.mockResolvedValue(true);

  const response = await POST(new Request('http://localhost/api/2fa/disable', { method: 'POST' }));

  expect(mocks.userUpdateMany).toHaveBeenCalledWith({
    where: { id: 'user-1', password: 'hashed-password', deletedAt: null },
    data: { sessionGeneration: { increment: 1 } },
  });
  expect(mocks.consumeOtp).toHaveBeenCalledWith('user-1', '123456', expect.any(Object));
  expect(mocks.deleteTwoFactorAuth).toHaveBeenCalledWith({
    where: { id: 'factor-1', userId: 'user-1', isEnabled: true },
  });
  expect(mocks.deleteRateLimit).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  expect(mocks.createSecureToken).toHaveBeenCalledWith(
    {
      userId: 'user-1',
      role: 'user',
      pwd: 'password-fingerprint',
      sessionGeneration: 1,
    },
    undefined,
    expect.any(Object),
  );
  expect(response.headers.get('set-cookie')).toContain('fresh-session');
  expect(response.headers.get('cache-control')).toBe('no-store');
  await expect(response.json()).resolves.toEqual({ ok: true, token: 'fresh-session' });
});

test('POST never deletes a different enrollment after concurrent replacement', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1' } },
    body: { password: 'password', token: '123456' },
    error: undefined,
  });
  mocks.getTwoFactorRequirement.mockResolvedValue({ reason: null });
  mocks.getUser.mockResolvedValue({ password: 'hashed-password' });
  mocks.checkPassword.mockResolvedValue(true);
  mocks.findTwoFactorAuth.mockResolvedValue({
    id: 'factor-1',
    isEnabled: true,
    secret: 'encrypted',
  });
  mocks.reserveTwoFactorAttempt.mockResolvedValue({ allowed: true });
  mocks.verifyTotp.mockResolvedValue(true);
  mocks.deleteTwoFactorAuth.mockResolvedValue({ count: 0 });

  const response = await POST(new Request('http://localhost/api/2fa/disable', { method: 'POST' }));

  expect(response.status).toBe(409);
  expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('POST does not issue a replacement session when rate-limit cleanup fails inside the transaction', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1' } },
    body: { password: 'password', token: '123456' },
    error: undefined,
  });
  mocks.getTwoFactorRequirement.mockResolvedValue({ reason: null });
  mocks.getUser.mockResolvedValue({ password: 'hashed-password' });
  mocks.checkPassword.mockResolvedValue(true);
  mocks.findTwoFactorAuth.mockResolvedValue({
    id: 'factor-1',
    isEnabled: true,
    secret: 'encrypted',
  });
  mocks.reserveTwoFactorAttempt.mockResolvedValue({ allowed: true });
  mocks.verifyTotp.mockResolvedValue(true);
  mocks.deleteRateLimit.mockRejectedValue(new Error('database unavailable'));

  await expect(
    POST(new Request('http://localhost/api/2fa/disable', { method: 'POST' })),
  ).rejects.toThrow('database unavailable');
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('POST stops password guessing before hash comparison when the shared budget is exhausted', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1' } },
    body: { password: 'guess', token: '123456' },
    error: undefined,
  });
  mocks.getTwoFactorRequirement.mockResolvedValue({ reason: null });
  mocks.getUser.mockResolvedValue({ password: 'hashed-password' });
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: false, retryAfter: 71 });

  const response = await POST(new Request('http://localhost/api/2fa/disable', { method: 'POST' }));

  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('71');
  expect(mocks.reservePasswordVerificationAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.getUser).toHaveBeenCalledWith('user-1', { includePassword: true });
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.verifyTotp).not.toHaveBeenCalled();
});

test('POST fails closed when the password attempt budget cannot be checked', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1' } },
    body: { password: 'guess', token: '123456' },
    error: undefined,
  });
  mocks.getTwoFactorRequirement.mockResolvedValue({ reason: null });
  mocks.getUser.mockResolvedValue({ password: 'hashed-password' });
  mocks.reservePasswordVerificationAttempt.mockRejectedValue(new Error('database unavailable'));

  const response = await POST(new Request('http://localhost/api/2fa/disable', { method: 'POST' }));

  expect(response.status).toBe(503);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('POST returns a configuration error after validating the caller', async () => {
  mocks.isTwoFactorConfigured.mockReturnValue(false);
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1' } },
    body: { password: 'secret', token: '123456' },
    error: undefined,
  });

  const response = await POST(new Request('http://localhost/api/2fa/disable', { method: 'POST' }));

  expect(mocks.parseRequest).toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-not-configured',
    },
  });
  expect(response.status).toBe(503);
});

test('POST rejects an exhausted attempt before checking the disable code', async () => {
  const lockedUntil = new Date('2026-10-03T12:15:00.000Z');
  mocks.parseRequest.mockResolvedValue({
    auth: { user: { id: 'user-1' } },
    body: { password: 'password', token: '123456' },
    error: undefined,
  });
  mocks.getTwoFactorRequirement.mockResolvedValue({ reason: null });
  mocks.getUser.mockResolvedValue({ password: 'hashed-password' });
  mocks.checkPassword.mockResolvedValue(true);
  mocks.findTwoFactorAuth.mockResolvedValue({ isEnabled: true, secret: 'encrypted' });
  mocks.reserveTwoFactorAttempt.mockResolvedValue({ allowed: false, lockedUntil });

  const response = await POST(new Request('http://localhost/api/2fa/disable', { method: 'POST' }));

  expect(response.status).toBe(429);
  expect(mocks.reserveTwoFactorAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.verifyTotp).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'two-factor-error-too-many-attempts', lockedUntil: lockedUntil.toISOString() },
  });
});
