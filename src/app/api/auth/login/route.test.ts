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
  reserveLoginOverflowAttempt: vi.fn(),
  releaseLoginAccountAttempt: vi.fn(),
  releaseLoginOverflowAttempt: vi.fn(),
  reserveLoginPasswordWork: vi.fn(),
  releaseLoginPasswordWork: vi.fn(),
  recordFailedLogin: vi.fn(),
  clearFailedLogins: vi.fn(),
  hashPassword: vi.fn(),
  passwordNeedsRehash: vi.fn(),
  rehashPasswordIfCurrent: vi.fn(),
  getTwoFactorRequirement: vi.fn(),
  isLoginCaptchaEnabled: vi.fn(),
  verifyLoginCaptcha: vi.fn(),
  lookupLoginRecoveryCode: vi.fn(),
  consumeLoginRecoveryCode: vi.fn(),
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
  releaseLoginOverflowAttempt: mocks.releaseLoginOverflowAttempt,
  reserveLoginPasswordWork: mocks.reserveLoginPasswordWork,
  releaseLoginPasswordWork: mocks.releaseLoginPasswordWork,
  reserveLoginAccountAttempt: mocks.reserveLoginAccountAttempt,
  reserveLoginOverflowAttempt: mocks.reserveLoginOverflowAttempt,
  recordFailedLogin: mocks.recordFailedLogin,
}));

vi.mock('@/lib/login-captcha', () => ({
  isLoginCaptchaEnabled: mocks.isLoginCaptchaEnabled,
  verifyLoginCaptcha: mocks.verifyLoginCaptcha,
}));

vi.mock('@/lib/login-recovery', () => ({
  lookupLoginRecoveryCode: mocks.lookupLoginRecoveryCode,
  consumeLoginRecoveryCode: mocks.consumeLoginRecoveryCode,
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
  mocks.reserveLoginOverflowAttempt.mockReset();
  mocks.releaseLoginAccountAttempt.mockReset();
  mocks.releaseLoginOverflowAttempt.mockReset();
  mocks.reserveLoginPasswordWork.mockReset();
  mocks.releaseLoginPasswordWork.mockReset();
  mocks.recordFailedLogin.mockReset();
  mocks.clearFailedLogins.mockReset();
  mocks.hashPassword.mockReset();
  mocks.passwordNeedsRehash.mockReset();
  mocks.rehashPasswordIfCurrent.mockReset();
  mocks.getTwoFactorRequirement.mockReset();
  mocks.isLoginCaptchaEnabled.mockReset().mockReturnValue(false);
  mocks.verifyLoginCaptcha.mockReset().mockResolvedValue('valid');
  mocks.lookupLoginRecoveryCode.mockReset().mockResolvedValue(null);
  mocks.consumeLoginRecoveryCode.mockReset().mockResolvedValue(null);

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
  mocks.reserveLoginOverflowAttempt.mockResolvedValue({ blocked: true });
  mocks.releaseLoginOverflowAttempt.mockResolvedValue(undefined);
  mocks.reserveLoginPasswordWork.mockResolvedValue({
    key: 'login-password-work:0',
    leaseId: 'lease-0',
  });
  mocks.releaseLoginPasswordWork.mockResolvedValue(undefined);
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

test('a rejected seeded password cannot consume the account budget after CAPTCHA', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'umami', captchaToken: 'test-token' },
    error: undefined,
  });

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.verifyLoginCaptcha).toHaveBeenCalledTimes(1);
  expect(mocks.recordFailedLogin).not.toHaveBeenCalled();
  expect(mocks.reserveLoginAccountAttempt).not.toHaveBeenCalled();
  expect(mocks.checkPassword).not.toHaveBeenCalled();
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
    expect(mocks.reserveLoginAccountAttempt).not.toHaveBeenCalled();
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
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledWith('alice');
  expect(mocks.releaseLoginAccountAttempt).not.toHaveBeenCalled();
  expect(mocks.checkPassword).toHaveBeenCalled();
});

test('distributed challenged first factors receive only a bounded overflow slot', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.createSecureToken.mockReturnValue('partial-fixture');
  let accountAttempts = 0;
  mocks.reserveLoginAccountAttempt.mockImplementation(async () => {
    accountAttempts += 1;
    return accountAttempts <= 10
      ? { blocked: false, retryAfter: 0, windowExpiresAt: '2030-01-01T00:00:00Z' }
      : { blocked: true, retryAfter: 120 };
  });
  mocks.reserveLoginOverflowAttempt.mockResolvedValueOnce({
    blocked: false,
    leaseId: 'lease-1',
    windowExpiresAt: '2030-01-01T00:00:00Z',
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    mocks.parseRequest.mockResolvedValueOnce({
      body: { username: 'alice', password: 'secret', captchaToken: `single-use-${attempt}` },
      error: undefined,
    });
    const response = await POST(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
          'x-real-ip': `192.0.2.${attempt + 1}`,
        },
      }),
    );
    expect(response.status).toBe(attempt < 11 ? 200 : 401);
  }

  expect(mocks.verifyLoginCaptcha).toHaveBeenCalledTimes(12);
  expect(mocks.reserveLoginOverflowAttempt).toHaveBeenCalledTimes(2);
  expect(mocks.releaseLoginOverflowAttempt).toHaveBeenCalledTimes(1);
  expect(mocks.checkPassword).toHaveBeenCalledTimes(11);
  expect(mocks.createSecureToken).toHaveBeenCalledTimes(11);
  expect(mocks.releaseLoginAccountAttempt).not.toHaveBeenCalled();
});

test('a valid CAPTCHA permits a correct password after account budget exhaustion', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.parseRequest
    .mockResolvedValueOnce({
      body: { username: 'alice', password: 'secret', captchaToken: 'first-token' },
      error: undefined,
    })
    .mockResolvedValueOnce({
      body: { username: 'alice', password: 'secret', captchaToken: 'second-token' },
      error: undefined,
    });
  mocks.checkPassword.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  mocks.createSecureToken.mockReturnValue('partial-fixture');
  mocks.reserveLoginAccountAttempt
    .mockResolvedValueOnce({
      blocked: false,
      retryAfter: 0,
      windowExpiresAt: '2030-01-01T00:00:00Z',
    })
    .mockResolvedValueOnce({ blocked: true, retryAfter: 120 });
  mocks.reserveLoginOverflowAttempt.mockResolvedValueOnce({
    blocked: false,
    leaseId: 'lease-1',
    windowExpiresAt: '2030-01-01T00:00:00Z',
  });

  const rejected = await POST(loginRequest());
  const challenged = await POST(loginRequest());

  expect(rejected.status).toBe(401);
  expect(challenged.status).toBe(200);
  await expect(challenged.json()).resolves.toMatchObject({
    requiresTwoFactor: true,
    partialToken: 'partial-fixture',
  });
  expect(mocks.checkPassword).toHaveBeenCalledTimes(2);
  expect(mocks.verifyLoginCaptcha).toHaveBeenCalledTimes(2);
  expect(mocks.verifyLoginCaptcha).toHaveBeenNthCalledWith(1, 'first-token', loginRequest().url);
  expect(mocks.verifyLoginCaptcha).toHaveBeenNthCalledWith(2, 'second-token', loginRequest().url);
  expect(mocks.getLoginLimit).toHaveBeenCalledTimes(2);
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledTimes(2);
  expect(mocks.reserveLoginOverflowAttempt).toHaveBeenCalledWith('alice');
  expect(mocks.releaseLoginOverflowAttempt).toHaveBeenCalledWith(
    'alice',
    '2030-01-01T00:00:00Z',
    'lease-1',
  );
  expect(mocks.createSecureToken).toHaveBeenLastCalledWith(
    { userId: 'user-1', pwd: 'password-fingerprint', sessionGeneration: 0, type: 'partial-auth' },
    undefined,
    { expiresIn: '5m' },
  );
  expect(mocks.releaseLoginAccountAttempt).not.toHaveBeenCalled();
});

test('overflow-store failure is not reported as an incorrect password', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.reserveLoginAccountAttempt.mockResolvedValue({ blocked: true, retryAfter: 120 });
  mocks.reserveLoginOverflowAttempt.mockRejectedValue(new Error('synthetic database outage'));

  const response = await POST(loginRequest());

  expect(response.status).toBe(503);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('overflow lease cleanup failure does not strand a verified first factor', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.reserveLoginAccountAttempt.mockResolvedValue({ blocked: true, retryAfter: 120 });
  mocks.reserveLoginOverflowAttempt.mockResolvedValue({
    blocked: false,
    leaseId: 'lease-1',
    windowExpiresAt: '2030-01-01T00:00:00Z',
  });
  mocks.releaseLoginOverflowAttempt.mockRejectedValue(new Error('synthetic database outage'));
  mocks.createSecureToken.mockReturnValue('partial-fixture');

  const response = await POST(loginRequest());

  expect(response.status).toBe(200);
  expect(mocks.releaseLoginOverflowAttempt).toHaveBeenCalledTimes(1);
});

test('distributed valid challenges cannot perform unbounded password checks for one account', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.checkPassword.mockResolvedValue(false);
  let accountAttempts = 0;
  mocks.reserveLoginAccountAttempt.mockImplementation(async () => {
    accountAttempts += 1;
    return accountAttempts <= 10
      ? { blocked: false, retryAfter: 0, windowExpiresAt: '2030-01-01T00:00:00Z' }
      : { blocked: true, retryAfter: 120 };
  });
  mocks.reserveLoginOverflowAttempt.mockResolvedValueOnce({
    blocked: false,
    leaseId: 'lease-1',
    windowExpiresAt: '2030-01-01T00:00:00Z',
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    mocks.parseRequest.mockResolvedValueOnce({
      body: { username: 'alice', password: 'wrong', captchaToken: `single-use-${attempt}` },
      error: undefined,
    });
    const response = await POST(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
          'x-real-ip': `192.0.2.${attempt + 1}`,
        },
      }),
    );
    expect(response.status).toBe(401);
  }

  expect(mocks.verifyLoginCaptcha).toHaveBeenCalledTimes(12);
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledTimes(12);
  expect(mocks.reserveLoginOverflowAttempt).toHaveBeenCalledTimes(2);
  expect(mocks.releaseLoginOverflowAttempt).toHaveBeenCalledTimes(1);
  expect(mocks.checkPassword).toHaveBeenCalledTimes(11);
  expect(mocks.releaseLoginAccountAttempt).not.toHaveBeenCalled();
});

test('a valid CAPTCHA gives unknown users the same password-check path', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.getUserByUsername.mockResolvedValue(null);
  mocks.checkPassword.mockResolvedValue(false);
  mocks.parseRequest.mockResolvedValue({
    body: { username: 'missing', password: 'secret', captchaToken: 'test-token' },
    error: undefined,
  });

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.checkPassword).toHaveBeenCalledWith('secret', expect.any(String));
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledWith('missing');
  expect(mocks.recordFailedLogin).not.toHaveBeenCalled();
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
  expect(mocks.releaseLoginAccountAttempt).not.toHaveBeenCalled();
  expect(mocks.clearFailedLogins).not.toHaveBeenCalled();
});

test.each([false, true])(
  'repeated successful first factors retain the source budget until 2FA (Redis %s)',
  async enabled => {
    redis.enabled = enabled;
    let sourceAttempts = 0;
    mocks.getLoginLimit.mockImplementation(async () => ({
      blocked: ++sourceAttempts > 10,
      retryAfter: 900,
    }));
    mocks.clearFailedLogins.mockImplementation(async () => {
      sourceAttempts = 0;
    });
    mocks.createSecureToken.mockReturnValue('partial-fixture');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await POST(loginRequest());
      expect(response.status).toBe(200);
      expect(response.headers.has('set-cookie')).toBe(false);
    }

    const denied = await POST(loginRequest());
    expect(denied.status).toBe(429);
    expect(mocks.checkPassword).toHaveBeenCalledTimes(10);
    expect(mocks.clearFailedLogins).not.toHaveBeenCalled();
  },
);

test('without CAPTCHA, an exhausted account budget denies a correct password before hashing', async () => {
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
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledWith('alice');
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.releaseLoginAccountAttempt).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test.each([false, true])(
  'an account-owned code reaches password verification despite an exhausted source limit (CAPTCHA %s)',
  async captchaEnabled => {
    mocks.isLoginCaptchaEnabled.mockReturnValue(captchaEnabled);
    mocks.parseRequest.mockResolvedValue({
      body: {
        username: 'alice',
        password: 'secret',
        recoveryCode: 'UR-RECOVERY-FIXTURE',
        captchaToken: 'single-use-captcha',
      },
      error: undefined,
    });
    mocks.getLoginLimit.mockResolvedValue({ blocked: true, retryAfter: 900 });
    mocks.reserveLoginAccountAttempt.mockResolvedValue({ blocked: true, retryAfter: 900 });
    mocks.lookupLoginRecoveryCode.mockResolvedValue({
      userId: 'user-1',
      passwordHash: 'hashed-password',
    });
    mocks.consumeLoginRecoveryCode.mockResolvedValue('user-1');
    mocks.createSecureToken.mockReturnValue('partial-fixture');

    const response = await POST(loginRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ requiresTwoFactor: true });
    expect(mocks.lookupLoginRecoveryCode).toHaveBeenCalledWith('alice', 'UR-RECOVERY-FIXTURE');
    expect(mocks.consumeLoginRecoveryCode).toHaveBeenCalledWith('alice', 'UR-RECOVERY-FIXTURE', {
      userId: 'user-1',
      passwordHash: 'hashed-password',
    });
    expect(mocks.reserveLoginAccountAttempt).not.toHaveBeenCalled();
    expect(mocks.reserveLoginOverflowAttempt).not.toHaveBeenCalled();
    expect(mocks.checkPassword).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLoginPasswordWork).toHaveBeenCalledTimes(1);
    expect(mocks.verifyLoginCaptcha).toHaveBeenCalledTimes(captchaEnabled ? 1 : 0);
  },
);

test('an invalid account-owned code never spends password work or reveals the user', async () => {
  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'secret', recoveryCode: 'UR-INVALID' },
    error: undefined,
  });
  mocks.getLoginLimit.mockResolvedValue({ blocked: true, retryAfter: 900 });

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.lookupLoginRecoveryCode).toHaveBeenCalledTimes(1);
  expect(mocks.consumeLoginRecoveryCode).not.toHaveBeenCalled();
  expect(mocks.reserveLoginPasswordWork).not.toHaveBeenCalled();
  expect(mocks.getUserByUsername).not.toHaveBeenCalled();
});

test('a raced or already-used recovery code does not check the password', async () => {
  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'secret', recoveryCode: 'UR-RECOVERY-FIXTURE' },
    error: undefined,
  });
  mocks.lookupLoginRecoveryCode.mockResolvedValue({
    userId: 'user-1',
    passwordHash: 'hashed-password',
  });
  mocks.consumeLoginRecoveryCode.mockResolvedValue(null);

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.releaseLoginPasswordWork).toHaveBeenCalledTimes(1);
});

test('a failed account lookup does not consume an account-owned code', async () => {
  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'secret', recoveryCode: 'UR-RECOVERY-FIXTURE' },
    error: undefined,
  });
  mocks.lookupLoginRecoveryCode.mockResolvedValue({
    userId: 'user-1',
    passwordHash: 'hashed-password',
  });
  mocks.getUserByUsername.mockRejectedValue(new Error('temporary database failure'));

  await expect(POST(loginRequest())).rejects.toThrow('temporary database failure');

  expect(mocks.consumeLoginRecoveryCode).not.toHaveBeenCalled();
  expect(mocks.releaseLoginPasswordWork).toHaveBeenCalledTimes(1);
});

test('an incorrect password consumes only one recovery code and issues no session', async () => {
  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'wrong', recoveryCode: 'UR-RECOVERY-FIXTURE' },
    error: undefined,
  });
  mocks.lookupLoginRecoveryCode.mockResolvedValue({
    userId: 'user-1',
    passwordHash: 'hashed-password',
  });
  mocks.consumeLoginRecoveryCode.mockResolvedValue('user-1');
  mocks.checkPassword.mockResolvedValue(false);

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.consumeLoginRecoveryCode).toHaveBeenCalledTimes(1);
  expect(mocks.checkPassword).toHaveBeenCalledTimes(1);
  expect(mocks.reserveLoginAccountAttempt).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  expect(mocks.recordFailedLogin).not.toHaveBeenCalled();
});

test('password rotation between code lookup and account lookup cannot issue a session', async () => {
  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'new-password', recoveryCode: 'UR-RECOVERY-FIXTURE' },
    error: undefined,
  });
  mocks.lookupLoginRecoveryCode.mockResolvedValue({
    userId: 'user-1',
    passwordHash: 'old-hash',
  });
  mocks.consumeLoginRecoveryCode.mockResolvedValue('user-1');
  mocks.getUserByUsername.mockResolvedValue({
    id: 'user-1',
    username: 'alice',
    password: 'new-hash',
    sessionGeneration: 1,
    role: 'admin',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
});

test('an exhausted username budget stops before account lookup', async () => {
  mocks.getUserByUsername.mockResolvedValue(null);
  mocks.reserveLoginAccountAttempt.mockResolvedValue({ blocked: true, retryAfter: 120 });

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenCalledWith('alice');
  expect(mocks.getUserByUsername).not.toHaveBeenCalled();
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('admission precedes account lookup for known and unknown usernames', async () => {
  mocks.getUserByUsername.mockResolvedValueOnce(null);
  mocks.checkPassword.mockResolvedValue(false);

  const unknown = await POST(loginRequest());
  const known = await POST(loginRequest());

  expect(unknown.status).toBe(401);
  expect(known.status).toBe(401);
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenNthCalledWith(1, 'alice');
  expect(mocks.reserveLoginAccountAttempt).toHaveBeenNthCalledWith(2, 'alice');
  expect(mocks.reserveLoginAccountAttempt.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.getUserByUsername.mock.invocationCallOrder[0],
  );
  expect(mocks.checkPassword).toHaveBeenCalledTimes(2);
});

test('exhausted shared password capacity rejects before account lookup', async () => {
  mocks.reserveLoginPasswordWork.mockResolvedValue(null);

  const response = await POST(loginRequest());

  expect(response.status).toBe(503);
  expect(mocks.reserveLoginAccountAttempt).not.toHaveBeenCalled();
  expect(mocks.getUserByUsername).not.toHaveBeenCalled();
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('an unavailable password-work store fails closed before account lookup', async () => {
  mocks.reserveLoginPasswordWork.mockRejectedValue(new Error('synthetic database outage'));

  const response = await POST(loginRequest());

  expect(response.status).toBe(503);
  expect(mocks.reserveLoginAccountAttempt).not.toHaveBeenCalled();
  expect(mocks.getUserByUsername).not.toHaveBeenCalled();
});

test('password work lease is released after a rejected first factor', async () => {
  mocks.checkPassword.mockResolvedValue(false);

  const response = await POST(loginRequest());

  expect(response.status).toBe(401);
  expect(mocks.releaseLoginPasswordWork).toHaveBeenCalledWith({
    key: 'login-password-work:0',
    leaseId: 'lease-0',
  });
});

test('a password-check exception releases both bounded leases', async () => {
  mocks.isLoginCaptchaEnabled.mockReturnValue(true);
  mocks.reserveLoginAccountAttempt.mockResolvedValue({ blocked: true, retryAfter: 120 });
  mocks.reserveLoginOverflowAttempt.mockResolvedValue({
    blocked: false,
    leaseId: 'overflow-1',
    windowExpiresAt: '2030-01-01T00:00:00Z',
  });
  mocks.checkPassword.mockRejectedValue(new Error('synthetic hash failure'));

  await expect(POST(loginRequest())).rejects.toThrow('synthetic hash failure');

  expect(mocks.releaseLoginOverflowAttempt).toHaveBeenCalledWith(
    'alice',
    '2030-01-01T00:00:00Z',
    'overflow-1',
  );
  expect(mocks.releaseLoginPasswordWork).toHaveBeenCalledWith({
    key: 'login-password-work:0',
    leaseId: 'lease-0',
  });
});

test.each([false, true])(
  'database admission failure stops password verification with CAPTCHA enabled %s',
  async captchaEnabled => {
    mocks.isLoginCaptchaEnabled.mockReturnValue(captchaEnabled);
    if (captchaEnabled) {
      mocks.parseRequest.mockResolvedValue({
        body: { username: 'alice', password: 'secret', captchaToken: 'single-use-token' },
        error: undefined,
      });
    }
    mocks.reserveLoginAccountAttempt.mockRejectedValue(new Error('database unavailable'));

    const response = await POST(loginRequest());

    expect(response.status).toBe(503);
    expect(mocks.checkPassword).not.toHaveBeenCalled();
  },
);

test('database release failure does not issue a session after password verification', async () => {
  mocks.findTwoFactorAuth.mockResolvedValue(null);
  mocks.releaseLoginAccountAttempt.mockRejectedValue(new Error('database unavailable'));

  const response = await POST(loginRequest());

  expect(response.status).toBe(503);
  expect(mocks.saveAuth).not.toHaveBeenCalled();
  expect(mocks.createSecureToken).not.toHaveBeenCalled();
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
  expect(mocks.clearFailedLogins).not.toHaveBeenCalled();
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
    expect(mocks.clearFailedLogins).not.toHaveBeenCalled();
    expect(mocks.releaseLoginAccountAttempt).not.toHaveBeenCalled();
    if (enabled) {
      expect(mocks.saveAuth).toHaveBeenCalledWith(
        {
          userId: 'user-1',
          role: 'admin',
          pwd: 'password-fingerprint',
          sessionGeneration: 0,
          type: 'enrollment-auth',
          accountAttemptId: expect.any(String),
          accountAttemptExpiresAt: '2030-01-01T00:00:00Z',
          accountAttemptKeyVersion: 2,
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
          accountAttemptId: expect.any(String),
          accountAttemptExpiresAt: '2030-01-01T00:00:00Z',
          accountAttemptKeyVersion: 2,
        },
        undefined,
        { expiresIn: 900 },
      );
    }
  },
);

test.each([false, true])(
  'a completed single-factor login clears the source budget after session issuance (Redis %s)',
  async enabled => {
    redis.enabled = enabled;
    mocks.findTwoFactorAuth.mockResolvedValue(null);
    mocks.getTwoFactorRequirement.mockResolvedValue({ reason: null, globalRequired: false });
    mocks.createSecureToken.mockReturnValue('full-token');
    mocks.saveAuth.mockResolvedValue('full-token');
    mocks.getAllUserTeams.mockResolvedValue([]);

    const response = await POST(loginRequest());

    expect(response.status).toBe(200);
    expect(response.headers.has('set-cookie')).toBe(true);
    expect(mocks.clearFailedLogins).toHaveBeenCalledWith(expect.any(Request), 'alice');
    expect(mocks.releaseLoginAccountAttempt).toHaveBeenCalledWith('alice', '2030-01-01T00:00:00Z');
    const issuer = enabled ? mocks.saveAuth : mocks.createSecureToken;
    expect(issuer.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearFailedLogins.mock.invocationCallOrder[0],
    );
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
    {
      userId: 'user-1',
      pwd: 'password-fingerprint',
      sessionGeneration: 0,
      accountAttemptId: expect.any(String),
      accountAttemptExpiresAt: '2030-01-01T00:00:00Z',
      accountAttemptKeyVersion: 2,
      type: 'partial-auth',
    },
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
      accountAttemptId: expect.any(String),
      accountAttemptExpiresAt: '2030-01-01T00:00:00Z',
      accountAttemptKeyVersion: 2,
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
