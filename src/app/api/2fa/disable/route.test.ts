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
}));

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: { findUnique: mocks.findTwoFactorAuth },
    },
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
  resetRateLimit: vi.fn(),
}));

vi.mock('@/lib/two-factor/requirement', () => ({
  getTwoFactorRequirement: mocks.getTwoFactorRequirement,
}));

vi.mock('@/lib/two-factor/replay-prevention', () => ({
  consumeOtp: vi.fn(),
}));

vi.mock('@/lib/two-factor/totp', () => ({
  verifyTotp: mocks.verifyTotp,
}));

vi.mock('@/lib/password', () => ({
  checkPassword: mocks.checkPassword,
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

  mocks.isTwoFactorConfigured.mockReturnValue(true);
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
