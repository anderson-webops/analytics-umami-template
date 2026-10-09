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
  reserveLoginAccountAttempt: vi.fn(),
  releaseLoginAccountAttempt: vi.fn(),
  recordFailedLogin: vi.fn(),
  clearFailedLogins: vi.fn(),
  hashPassword: vi.fn(),
  passwordNeedsRehash: vi.fn(),
  rehashPasswordIfCurrent: vi.fn(),
  getTwoFactorRequirement: vi.fn(),
  isLoginCaptchaEnabled: vi.fn(),
  verifyLoginCaptcha: vi.fn(),
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
  releaseLoginAccountAttempt: mocks.releaseLoginAccountAttempt,
  reserveLoginAccountAttempt: mocks.reserveLoginAccountAttempt,
  recordFailedLogin: mocks.recordFailedLogin,
}));

vi.mock('@/lib/login-captcha', () => ({
  isLoginCaptchaEnabled: mocks.isLoginCaptchaEnabled,
  verifyLoginCaptcha: mocks.verifyLoginCaptcha,
}));

vi.mock('@/queries/prisma/user', () => ({
  rehashPasswordIfCurrent: mocks.rehashPasswordIfCurrent,
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

vi.mock('@/lib/two-factor/requirement', () => ({
  getTwoFactorRequirement: mocks.getTwoFactorRequirement,
}));

import { POST } from './route';

beforeEach(() => {
  vi.stubEnv('CLOUD_MODE', '0');
  vi.stubEnv('DISABLE_LOGIN', '0');
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
  mocks.reserveLoginAccountAttempt.mockReset();
  mocks.releaseLoginAccountAttempt.mockReset();
  mocks.recordFailedLogin.mockReset();
  mocks.clearFailedLogins.mockReset();
  mocks.hashPassword.mockReset();
  mocks.passwordNeedsRehash.mockReset();
  mocks.rehashPasswordIfCurrent.mockReset();
  mocks.getTwoFactorRequirement.mockReset();
  mocks.isLoginCaptchaEnabled.mockReset().mockReturnValue(false);
  mocks.verifyLoginCaptcha.mockReset().mockResolvedValue('valid');

  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'secret' },
    error: undefined,
  });
  mocks.getUserByUsername.mockResolvedValue({
    id: 'user-1',
    username: 'alice',
    password: 'hashed-password',
    sessionGeneration: 0,
    role: 'admin',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  mocks.checkPassword.mockReturnValue(true);
  mocks.hash.mockReturnValue('password-fingerprint');
  mocks.getLoginLimit.mockResolvedValue({ blocked: false, retryAfter: 900 });
  mocks.reserveLoginAccountAttempt.mockResolvedValue({
    blocked: false,
    retryAfter: 0,
    windowExpiresAt: '2030-01-01T00:00:00Z',
  });
  mocks.releaseLoginAccountAttempt.mockResolvedValue(undefined);
  mocks.recordFailedLogin.mockResolvedValue({ blocked: false, retryAfter: 900 });
  mocks.clearFailedLogins.mockResolvedValue(undefined);
  mocks.passwordNeedsRehash.mockReturnValue(false);
  mocks.findTwoFactorAuth.mockResolvedValue({ userId: 'user-1', isEnabled: true });
  mocks.isTwoFactorConfigured.mockReturnValue(true);
  mocks.getTwoFactorRequirement.mockResolvedValue({ reason: null, globalRequired: false });
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

test.each([false, true])('cloud mode rejects local password login (Redis %s)', async enabled => {
  vi.stubEnv('CLOUD_MODE', '1');
  redis.enabled = enabled;

  const response = await POST(loginRequest());

  expect(response.status).toBe(404);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(mocks.parseRequest).not.toHaveBeenCalled();
  expect(mocks.findTwoFactorAuth).not.toHaveBeenCalled();
  expect(mocks.saveAuth).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test.each([false, true])(
  'disabled login rejects direct password API requests (Redis %s)',
  async enabled => {
    vi.stubEnv('DISABLE_LOGIN', '1');
    redis.enabled = enabled;

    const response = await POST(loginRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'login-disabled' } });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(mocks.parseRequest).not.toHaveBeenCalled();
    expect(mocks.checkPassword).not.toHaveBeenCalled();
    expect(mocks.saveAuth).not.toHaveBeenCalled();
    expect(mocks.createSecureToken).not.toHaveBeenCalled();
  },
);

test('known seeded password cannot authenticate any local account', async () => {
  mocks.parseRequest.mockResolvedValue({
    body: { username: 'admin', password: 'umami' },
    error: undefined,
  });

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(mocks.getUserByUsername).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test.each(['invalid', 'unavailable'] as const)(
  '%s CAPTCHA result stops password verification',
  async result => {
    mocks.isLoginCaptchaEnabled.mockReturnValue(true);
    mocks.verifyLoginCaptcha.mockResolvedValue(result);
    mocks.parseRequest.mockResolvedValue({
      auth: null,
      body: { username: 'alice', password: 'secret', captchaToken: 'test-token' },
      error: undefined,
    });

    const response = await POST(loginRequest());

    expect(response.status).toBe(result === 'invalid' ? 401 : 503);
    expect(mocks.verifyLoginCaptcha).toHaveBeenCalledWith('test-token', loginRequest().url);
    expect(mocks.getUserByUsername).not.toHaveBeenCalled();
    expect(mocks.checkPassword).not.toHaveBeenCalled();
  },
);

test('valid CAPTCHA preserves the existing two-factor login step', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.createSecureToken.mockReturnValue('partial-fixture');
  mocks.parseRequest.mockResolvedValue({
    auth: null,
    body: { username: 'alice', password: 'secret', captchaToken: 'test-token' },
    error: undefined,
  });

  const response = await POST(loginRequest());

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    requiresTwoFactor: true,
    partialToken: 'partial-fixture',
  });
  expect(mocks.verifyLoginCaptcha).toHaveBeenCalledWith('test-token', loginRequest().url);
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.releaseLoginAccountAttempt).toHaveBeenCalledWith('user-1', '2030-01-01T00:00:00Z');
  expect(mocks.checkPassword).toHaveBeenCalled();
});

test('a failed login does not block a later correct password while admission remains', async () => {
  mocks.checkPassword.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  mocks.createSecureToken.mockReturnValue('partial-fixture');

  const rejected = await POST(loginRequest());
  const authenticated = await POST(loginRequest());

  expect(rejected.status).toBe(401);
  expect(authenticated.status).toBe(200);
  expect(await authenticated.json()).toEqual({
    requiresTwoFactor: true,
    partialToken: 'partial-fixture',
  });
  expect(mocks.recordFailedLogin).toHaveBeenCalledTimes(1);
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledTimes(2);
  expect(mocks.releaseLoginAccountAttempt).toHaveBeenCalledTimes(1);
  expect(mocks.clearFailedLogins).toHaveBeenCalledWith(expect.any(Request), 'alice');
});

test.each([false, true])(
  'an exhausted account budget denies even a correct password before hashing (CAPTCHA %s)',
  async captchaEnabled => {
    mocks.isLoginCaptchaEnabled.mockReturnValue(captchaEnabled);
    mocks.parseRequest.mockResolvedValue({
      body: { username: 'alice', password: 'secret', captchaToken: 'test-token' },
      error: undefined,
    });
    mocks.reserveLoginAccountAttempt.mockResolvedValue({ blocked: true, retryAfter: 120 });

    const response = await POST(loginRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'incorrect-username-password' },
    });
    expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledWith('user-1');
    expect(mocks.checkPassword).not.toHaveBeenCalled();
    expect(mocks.releaseLoginAccountAttempt).not.toHaveBeenCalled();
    expect(mocks.createSecureToken).not.toHaveBeenCalled();
  },
);

test('unknown usernames share a bounded admission budget without exposing existence in status', async () => {
  mocks.getUserByUsername.mockResolvedValue(null);
  mocks.reserveLoginAccountAttempt.mockResolvedValue({ blocked: true, retryAfter: 120 });

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledWith(undefined);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('without CAPTCHA, database admission failure stops password verification', async () => {
  mocks.reserveLoginAccountAttempt.mockRejectedValue(new Error('database unavailable'));

  const response = await POST(loginRequest());

  expect(response.status).toBe(503);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('database release failure does not issue a session after password verification', async () => {
  mocks.releaseLoginAccountAttempt.mockRejectedValue(new Error('database unavailable'));

  const response = await POST(loginRequest());

  expect(response.status).toBe(503);
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test('per-IP limit stops password checks before they consume bcrypt work', async () => {
  mocks.getLoginLimit.mockResolvedValue({ blocked: true, retryAfter: 900 });

  const response = await POST(loginRequest());

  expect(response.status).toBe(429);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.recordFailedLogin).not.toHaveBeenCalled();
});

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

test.each([false, true])(
  'self-hosted required enrollment receives a short-lived limited session (Redis %s)',
  async enabled => {
    redis.enabled = enabled;
    mocks.findTwoFactorAuth.mockResolvedValue(null);
    mocks.getTwoFactorRequirement.mockResolvedValue({ reason: 'user', globalRequired: false });
    mocks.createSecureToken.mockReturnValue('enrollment-token');
    mocks.saveAuth.mockResolvedValue('enrollment-token');
    mocks.getAllUserTeams.mockResolvedValue([{ id: 'private-team', name: 'Private team' }]);

    const response = await POST(loginRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=900');
    expect(await response.json()).toMatchObject({
      token: 'enrollment-token',
      user: { teams: [] },
    });
    expect(mocks.getAllUserTeams).not.toHaveBeenCalled();
    if (enabled) {
      expect(mocks.saveAuth).toHaveBeenCalledWith(
        {
          userId: 'user-1',
          role: 'admin',
          pwd: 'password-fingerprint',
          sessionGeneration: 0,
          type: 'enrollment-auth',
        },
        900,
      );
    } else {
      expect(mocks.createSecureToken).toHaveBeenCalledWith(
        {
          userId: 'user-1',
          role: 'admin',
          pwd: 'password-fingerprint',
          sessionGeneration: 0,
          type: 'enrollment-auth',
        },
        undefined,
        { expiresIn: 900 },
      );
    }
  },
);

test('required enrollment cannot mint a session without the 2FA key', async () => {
  mocks.findTwoFactorAuth.mockResolvedValue(null);
  mocks.getTwoFactorRequirement.mockResolvedValue({ reason: 'user', globalRequired: false });
  mocks.isTwoFactorConfigured.mockReturnValue(false);

  const response = await POST(loginRequest());

  expect(response.status).toBe(503);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(mocks.saveAuth).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('self-hosted enrollment decisions use the primary instead of stale replica state', async () => {
  mocks.findTwoFactorAuth.mockResolvedValue(null);
  const findPrimaryEnrollment = vi.fn().mockResolvedValue({ isEnabled: true });
  (prisma.client as any).$primary = () => ({
    twoFactorAuth: { findUnique: findPrimaryEnrollment },
  });
  mocks.createSecureToken.mockReturnValue('partial-fixture');

  const response = await POST(loginRequest());

  expect(response.status).toBe(200);
  expect(findPrimaryEnrollment).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  expect(mocks.findTwoFactorAuth).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).toHaveBeenCalledWith(
    { userId: 'user-1', pwd: 'password-fingerprint', sessionGeneration: 0, type: 'partial-auth' },
    undefined,
    { expiresIn: '5m' },
  );
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test('password-hash upgrade keeps the existing credential generation during login', async () => {
  mocks.passwordNeedsRehash.mockReturnValue(true);
  mocks.hashPassword.mockResolvedValue('upgraded-password-hash');
  mocks.rehashPasswordIfCurrent.mockResolvedValue({ sessionGeneration: 0 });
  mocks.createSecureToken.mockReturnValue('partial-fixture');

  const response = await POST(loginRequest());

  expect(response.status).toBe(200);
  expect(mocks.rehashPasswordIfCurrent).toHaveBeenCalledWith(
    'user-1',
    'hashed-password',
    'upgraded-password-hash',
    0,
  );
  expect(mocks.createSecureToken).toHaveBeenCalledWith(
    {
      userId: 'user-1',
      pwd: 'password-fingerprint',
      sessionGeneration: 0,
      type: 'partial-auth',
    },
    undefined,
    { expiresIn: '5m' },
  );
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
