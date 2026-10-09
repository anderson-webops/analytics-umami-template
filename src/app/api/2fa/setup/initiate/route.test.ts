import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { POST } from './route';
import { initiateTwoFactorSetupSchema } from './schema';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getUser: vi.fn(),
  checkPassword: vi.fn(),
  reservePasswordVerificationAttempt: vi.fn(),
  findUnique: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
  generateTotpSecret: vi.fn(),
  encryptSecret: vi.fn(),
  isTwoFactorConfigured: vi.fn(),
  generateOtpAuthUri: vi.fn(),
  generateQrCodeDataUrl: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/queries/prisma/user', () => ({
  getUser: mocks.getUser,
}));

vi.mock('@/lib/password', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/password')>()),
  checkPassword: mocks.checkPassword,
}));

vi.mock('@/lib/password-verification-rate-limit', () => ({
  reservePasswordVerificationAttempt: mocks.reservePasswordVerificationAttempt,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: {
        findUnique: mocks.findUnique,
        createMany: mocks.createMany,
        updateMany: mocks.updateMany,
      },
    },
  },
}));

vi.mock('@/lib/two-factor/crypto', () => ({
  encryptSecret: mocks.encryptSecret,
  getTwoFactorConfigurationError: () => ({
    code: 'two-factor-error-not-configured',
    message: 'TWO_FACTOR_ENCRYPTION_KEY is missing or invalid',
  }),
  isTwoFactorConfigured: mocks.isTwoFactorConfigured,
}));

vi.mock('@/lib/two-factor/totp', () => ({
  generateOtpAuthUri: mocks.generateOtpAuthUri,
  generateQrCodeDataUrl: mocks.generateQrCodeDataUrl,
  generateTotpSecret: mocks.generateTotpSecret,
}));

beforeEach(() => {
  vi.stubEnv('CLOUD_MODE', '0');
  vi.stubEnv('DISABLE_LOGIN', '0');
  mocks.parseRequest.mockReset();
  mocks.getUser.mockReset();
  mocks.checkPassword.mockReset();
  mocks.reservePasswordVerificationAttempt.mockReset();
  mocks.findUnique.mockReset();
  mocks.createMany.mockReset();
  mocks.updateMany.mockReset();
  mocks.generateTotpSecret.mockReset();
  mocks.encryptSecret.mockReset();
  mocks.isTwoFactorConfigured.mockReset();
  mocks.generateOtpAuthUri.mockReset();
  mocks.generateQrCodeDataUrl.mockReset();

  mocks.isTwoFactorConfigured.mockReturnValue(true);
  mocks.parseRequest.mockResolvedValue({
    auth: { authType: 'session', user: { id: 'user-1' } },
    body: { password: 'current-password' },
    error: undefined,
  });
  mocks.getUser.mockResolvedValue({ id: 'user-1', username: 'alice', password: 'password-hash' });
  mocks.checkPassword.mockResolvedValue(true);
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: true, retryAfter: 0 });
  mocks.findUnique.mockResolvedValue(null);
  mocks.generateTotpSecret.mockReturnValue('plain-secret');
  mocks.encryptSecret.mockReturnValue('encrypted-secret');
  mocks.generateOtpAuthUri.mockReturnValue('otpauth://alice');
  mocks.generateQrCodeDataUrl.mockResolvedValue('data:image/png;base64,qr');
  mocks.createMany.mockResolvedValue({ count: 1 });
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('POST stays unavailable in cloud mode before reading a session', async () => {
  vi.stubEnv('CLOUD_MODE', '1');

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(response.status).toBe(404);
  expect(mocks.parseRequest).not.toHaveBeenCalled();
  expect(mocks.getUser).not.toHaveBeenCalled();
});

test('disabled login cannot start setup from an enrollment-only session', async () => {
  vi.stubEnv('DISABLE_LOGIN', '1');
  mocks.parseRequest.mockResolvedValue({
    auth: { authType: 'session', user: { id: 'user-1' }, enrollmentOnly: true },
    body: { password: 'current-password' },
    error: undefined,
  });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(response.status).toBe(403);
  expect(mocks.getUser).not.toHaveBeenCalled();
  expect(mocks.generateTotpSecret).not.toHaveBeenCalled();
});

test('POST creates a pending 2FA setup and returns the manual key and QR data', async () => {
  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(mocks.getUser).toHaveBeenCalledWith('user-1', { includePassword: true });
  expect(mocks.reservePasswordVerificationAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.checkPassword).toHaveBeenCalledWith('current-password', 'password-hash');
  expect(mocks.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  expect(mocks.createMany).toHaveBeenCalledWith({
    data: [{ userId: 'user-1', secret: 'encrypted-secret', isEnabled: false }],
    skipDuplicates: true,
  });
  await expect(response.json()).resolves.toEqual({
    manualKey: 'plain-secret',
    qrCodeDataUrl: 'data:image/png;base64,qr',
  });
  expect(response.status).toBe(200);
});

test('a password is required before starting setup', () => {
  expect(initiateTwoFactorSetupSchema.safeParse({}).success).toBe(false);
  expect(initiateTwoFactorSetupSchema.safeParse({ password: '' }).success).toBe(false);
  expect(initiateTwoFactorSetupSchema.safeParse({ password: 'current-password' }).success).toBe(
    true,
  );
});

test('POST rejects an incorrect password without exposing or replacing a secret', async () => {
  mocks.checkPassword.mockResolvedValue(false);

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'two-factor-error-incorrect-password' },
  });
  expect(mocks.generateTotpSecret).not.toHaveBeenCalled();
  expect(mocks.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  expect(mocks.createMany).not.toHaveBeenCalled();
  expect(mocks.updateMany).not.toHaveBeenCalled();
});

test('POST stops password guessing before comparison when the shared limit is exhausted', async () => {
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: false, retryAfter: 71 });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(response.status).toBe(429);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.generateTotpSecret).not.toHaveBeenCalled();
});

test('POST fails closed when the password-attempt budget is unavailable', async () => {
  mocks.reservePasswordVerificationAttempt.mockRejectedValue(new Error('database unavailable'));

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(response.status).toBe(503);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.generateTotpSecret).not.toHaveBeenCalled();
});

test('POST refuses share-only authorization before looking up credentials', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { authType: 'share', shareToken: { shareId: 'share-1' } },
    body: { password: 'current-password' },
  });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  expect(mocks.getUser).not.toHaveBeenCalled();
  expect(mocks.generateTotpSecret).not.toHaveBeenCalled();
});

test('POST reports a configuration error when the encryption key is missing', async () => {
  mocks.isTwoFactorConfigured.mockReturnValue(false);

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(mocks.createMany).not.toHaveBeenCalled();
  expect(mocks.updateMany).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-not-configured',
    },
  });
  expect(response.status).toBe(503);
});

test('POST rejects setup when 2FA is already enabled for the user', async () => {
  mocks.findUnique.mockResolvedValue({ userId: 'user-1', isEnabled: true });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(mocks.createMany).not.toHaveBeenCalled();
  expect(mocks.updateMany).not.toHaveBeenCalled();
  expect(mocks.reservePasswordVerificationAttempt).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-already-enabled',
    },
  });
  expect(response.status).toBe(400);
});

test('POST replaces only the same still-pending setup', async () => {
  mocks.findUnique.mockResolvedValue({
    id: 'enrollment-1',
    userId: 'user-1',
    secret: 'prior-secret',
    isEnabled: false,
  });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

  expect(mocks.updateMany).toHaveBeenCalledWith({
    where: {
      id: 'enrollment-1',
      userId: 'user-1',
      secret: 'prior-secret',
      isEnabled: false,
    },
    data: { secret: 'encrypted-secret' },
  });
  expect(mocks.createMany).not.toHaveBeenCalled();
  expect(response.status).toBe(200);
});

test.each(['createMany', 'updateMany'])(
  'POST rejects a setup changed during %s without exposing its unused secret',
  async write => {
    if (write === 'updateMany') {
      mocks.findUnique.mockResolvedValue({
        id: 'enrollment-1',
        userId: 'user-1',
        secret: 'prior-secret',
        isEnabled: false,
      });
    }
    mocks[write].mockResolvedValue({ count: 0 });

    const response = await POST(
      new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'two-factor-error-setup-changed' },
    });
  },
);
