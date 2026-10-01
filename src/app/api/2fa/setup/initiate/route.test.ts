import { beforeEach, expect, test, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getUser: vi.fn(),
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
  mocks.parseRequest.mockReset();
  mocks.getUser.mockReset();
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
    auth: { user: { id: 'user-1' } },
    error: undefined,
  });
  mocks.getUser.mockResolvedValue({ id: 'user-1', username: 'alice' });
  mocks.findUnique.mockResolvedValue(null);
  mocks.generateTotpSecret.mockReturnValue('plain-secret');
  mocks.encryptSecret.mockReturnValue('encrypted-secret');
  mocks.generateOtpAuthUri.mockReturnValue('otpauth://alice');
  mocks.generateQrCodeDataUrl.mockResolvedValue('data:image/png;base64,qr');
  mocks.createMany.mockResolvedValue({ count: 1 });
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

test('POST creates a pending 2FA setup and returns the manual key and QR data', async () => {
  const response = await POST(
    new Request('http://localhost/api/2fa/setup/initiate', { method: 'POST' }),
  );

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
