import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getUserByUsername: vi.fn(),
  checkPassword: vi.fn(),
  findTwoFactorAuth: vi.fn(),
  createSecureToken: vi.fn(),
  secret: vi.fn(),
  hash: vi.fn(),
  getAllUserTeams: vi.fn(),
  saveAuth: vi.fn(),
  isTwoFactorConfigured: vi.fn(),
  getLoginLimit: vi.fn(),
  clearFailedLogins: vi.fn(),
  hashPassword: vi.fn(),
  passwordNeedsRehash: vi.fn(),
  replacePasswordIfCurrent: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/queries/prisma', () => ({
  getAllUserTeams: mocks.getAllUserTeams,
  getUserByUsername: mocks.getUserByUsername,
}));

vi.mock('@/lib/password', () => ({
  checkPassword: mocks.checkPassword,
  hashPassword: mocks.hashPassword,
  isAcceptableLoginPassword: () => true,
  isStrongPassword: () => true,
  passwordNeedsRehash: mocks.passwordNeedsRehash,
}));

vi.mock('@/lib/login-rate-limit', () => ({
  clearFailedLogins: mocks.clearFailedLogins,
  getLoginLimit: mocks.getLoginLimit,
}));

vi.mock('@/queries/prisma/user', () => ({
  replacePasswordIfCurrent: mocks.replacePasswordIfCurrent,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: {
        findUnique: mocks.findTwoFactorAuth,
      },
    },
  },
}));

vi.mock('@/lib/jwt', () => ({
  createSecureToken: mocks.createSecureToken,
}));

vi.mock('@/lib/crypto', () => ({
  hash: mocks.hash,
  secret: mocks.secret,
}));

vi.mock('@/lib/auth', () => ({
  saveAuth: mocks.saveAuth,
}));

vi.mock('@/lib/redis', () => ({
  default: {
    enabled: false,
  },
}));

vi.mock('@/lib/two-factor/crypto', () => ({
  getTwoFactorConfigurationError: () => ({
    code: 'two-factor-error-not-configured',
    message: 'TWO_FACTOR_ENCRYPTION_KEY is missing or invalid',
  }),
  isTwoFactorConfigured: mocks.isTwoFactorConfigured,
}));

import { POST } from './route';

beforeEach(() => {
  vi.stubEnv('CLOUD_MODE', '0');
  redis.enabled = false;
  delete (prisma.client as any).$primary;
  mocks.parseRequest.mockReset();
  mocks.getUserByUsername.mockReset();
  mocks.checkPassword.mockReset();
  mocks.findTwoFactorAuth.mockReset();
  mocks.createSecureToken.mockReset();
  mocks.secret.mockReset();
  mocks.hash.mockReset();
  mocks.getAllUserTeams.mockReset();
  mocks.saveAuth.mockReset();
  mocks.isTwoFactorConfigured.mockReset();
  mocks.getLoginLimit.mockReset();
  mocks.clearFailedLogins.mockReset();
  mocks.hashPassword.mockReset();
  mocks.passwordNeedsRehash.mockReset();
  mocks.replacePasswordIfCurrent.mockReset();

  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'secret' },
    error: undefined,
  });
  mocks.getUserByUsername.mockResolvedValue({
    id: 'user-1',
    username: 'alice',
    password: 'hashed-password',
    role: 'admin',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  mocks.checkPassword.mockReturnValue(true);
  mocks.hash.mockReturnValue('password-fingerprint');
  mocks.getLoginLimit.mockResolvedValue({ blocked: false, retryAfter: 900 });
  mocks.clearFailedLogins.mockResolvedValue(undefined);
  mocks.passwordNeedsRehash.mockReturnValue(false);
  mocks.findTwoFactorAuth.mockResolvedValue({ userId: 'user-1', isEnabled: true });
  mocks.isTwoFactorConfigured.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function loginRequest() {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  });
}

test.each([false, true])(
  'enrolled cloud login cannot create a session (Redis %s)',
  async enabled => {
    vi.stubEnv('CLOUD_MODE', '1');
    redis.enabled = enabled;

    const response = await POST(loginRequest());

    expect(response.status).toBe(503);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(mocks.findTwoFactorAuth).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(mocks.saveAuth).not.toHaveBeenCalled();
    expect(mocks.createSecureToken).not.toHaveBeenCalled();
    expect(mocks.replacePasswordIfCurrent).not.toHaveBeenCalled();
    expect(mocks.clearFailedLogins).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  'unenrolled cloud login retains its existing session flow (Redis %s)',
  async enabled => {
    vi.stubEnv('CLOUD_MODE', '1');
    redis.enabled = enabled;
    mocks.findTwoFactorAuth.mockResolvedValue(null);
    mocks.createSecureToken.mockReturnValue('fixture-token');
    mocks.saveAuth.mockResolvedValue('fixture-token');
    mocks.getAllUserTeams.mockResolvedValue([]);

    const response = await POST(loginRequest());

    expect(response.status).toBe(200);
    expect(response.headers.has('set-cookie')).toBe(true);
    expect(await response.json()).toMatchObject({ token: 'fixture-token' });
    expect(mocks.saveAuth).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(mocks.createSecureToken).toHaveBeenCalledTimes(enabled ? 0 : 1);
  },
);

test('self-hosted enrolled login still requires a partial two-factor challenge', async () => {
  mocks.createSecureToken.mockReturnValue('partial-fixture');

  const response = await POST(loginRequest());

  expect(response.status).toBe(200);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(await response.json()).toEqual({
    requiresTwoFactor: true,
    partialToken: 'partial-fixture',
  });
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test('cloud enrollment decisions use the primary instead of stale replica state', async () => {
  vi.stubEnv('CLOUD_MODE', '1');
  mocks.findTwoFactorAuth.mockResolvedValue(null);
  const findPrimaryEnrollment = vi.fn().mockResolvedValue({ isEnabled: true });
  (prisma.client as any).$primary = () => ({
    twoFactorAuth: { findUnique: findPrimaryEnrollment },
  });

  const response = await POST(loginRequest());

  expect(response.status).toBe(503);
  expect(findPrimaryEnrollment).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  expect(mocks.findTwoFactorAuth).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test('POST returns a configuration error instead of partial auth when 2FA is enabled but unavailable', async () => {
  mocks.isTwoFactorConfigured.mockReturnValue(false);

  const response = await POST(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost',
      },
    }),
  );

  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-not-configured',
    },
  });
  expect(response.status).toBe(503);
});
