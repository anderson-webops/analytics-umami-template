import { beforeEach, expect, test, vi } from 'vitest';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { canEnforceTwoFactorAuthForUser } from '@/permissions';
import { updateUser } from '@/queries/prisma/user';
import { DELETE, GET, POST } from './route';

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/permissions', () => ({
  canEnforceTwoFactorAuthForUser: vi.fn(),
}));

vi.mock('@/queries/prisma/user', () => ({
  updateUser: vi.fn(),
}));

vi.mock('@/lib/two-factor/crypto', () => ({
  getTwoFactorConfigurationError: () => ({
    code: 'two-factor-error-not-configured',
    message: 'TWO_FACTOR_ENCRYPTION_KEY is missing or invalid',
  }),
  isTwoFactorConfigured: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $queryRaw: vi.fn(),
      user: { findFirst: vi.fn(), updateMany: vi.fn() },
      twoFactorAuth: {
        findUnique: vi.fn(),
        deleteMany: vi.fn(),
      },
      twoFactorBackupCode: {
        deleteMany: vi.fn(),
      },
      twoFactorOtpUsed: {
        deleteMany: vi.fn(),
      },
      twoFactorRateLimit: {
        deleteMany: vi.fn(),
      },
      apiKey: {
        deleteMany: vi.fn(),
      },
    },
    transaction: vi.fn(),
  },
}));

const parseRequestMock = vi.mocked(parseRequest);
const canEnforceTwoFactorAuthForUserMock = vi.mocked(canEnforceTwoFactorAuthForUser);
const isTwoFactorConfiguredMock = vi.mocked(isTwoFactorConfigured);
const updateUserMock = vi.mocked(updateUser);
const prismaMock = prisma as any;

beforeEach(() => {
  parseRequestMock.mockReset();
  canEnforceTwoFactorAuthForUserMock.mockReset();
  isTwoFactorConfiguredMock.mockReset();
  updateUserMock.mockReset();
  prismaMock.client.$queryRaw.mockReset();
  prismaMock.client.twoFactorAuth.findUnique.mockReset();
  prismaMock.client.user.findFirst.mockReset();
  prismaMock.client.user.updateMany.mockReset();
  prismaMock.client.twoFactorAuth.deleteMany.mockReset();
  prismaMock.client.twoFactorBackupCode.deleteMany.mockReset();
  prismaMock.client.twoFactorOtpUsed.deleteMany.mockReset();
  prismaMock.client.twoFactorRateLimit.deleteMany.mockReset();
  prismaMock.client.apiKey.deleteMany.mockReset();
  prismaMock.transaction.mockReset();

  parseRequestMock.mockResolvedValue({
    auth: {
      user: {
        id: 'admin-1',
        isAdmin: true,
      },
    },
    error: undefined,
  });
  canEnforceTwoFactorAuthForUserMock.mockResolvedValue(true);
  isTwoFactorConfiguredMock.mockReturnValue(true);
  prismaMock.client.$queryRaw.mockResolvedValueOnce([]).mockResolvedValue([{ allowed: 1 }]);
  prismaMock.client.user.findFirst.mockImplementation(async ({ where }) => ({ id: where.id }));
  prismaMock.transaction.mockImplementation(async callback => callback(prismaMock.client));
});

test('GET returns whether 2FA is enabled for the target user', async () => {
  prismaMock.client.twoFactorAuth.findUnique.mockResolvedValue({
    userId: 'user-1',
    isEnabled: true,
  } as any);

  const response = await GET(new Request('http://localhost/api/admin/users/user-1/2fa'), {
    params: Promise.resolve({ userId: 'user-1' }),
  });

  await expect(response.json()).resolves.toEqual({ isEnabled: true });
  expect(response.status).toBe(200);
});

test('POST updates the user-level 2FA requirement flag', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {
      user: {
        id: 'admin-1',
        isAdmin: true,
      },
    },
    body: {
      required: true,
    },
    error: undefined,
  });
  updateUserMock.mockResolvedValue({ id: 'user-1' } as any);

  const response = await POST(
    new Request('http://localhost/api/admin/users/user-1/2fa', { method: 'POST' }),
    {
      params: Promise.resolve({ userId: 'user-1' }),
    },
  );

  expect(updateUserMock).toHaveBeenCalledWith('user-1', { twoFactorRequired: true }, 'admin-1');
  await expect(response.json()).resolves.toEqual({
    ok: true,
    userId: 'user-1',
    twoFactorRequired: true,
  });
  expect(response.status).toBe(200);
});

test('POST rejects enabling a user-level 2FA requirement when the encryption key is missing', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {
      user: {
        id: 'admin-1',
        isAdmin: true,
      },
    },
    body: {
      required: true,
    },
    error: undefined,
  });
  isTwoFactorConfiguredMock.mockReturnValue(false);

  const response = await POST(
    new Request('http://localhost/api/admin/users/user-1/2fa', { method: 'POST' }),
    {
      params: Promise.resolve({ userId: 'user-1' }),
    },
  );

  expect(updateUserMock).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-not-configured',
    },
  });
  expect(response.status).toBe(503);
});

test('DELETE clears the user 2FA configuration and related support tables', async () => {
  prismaMock.client.user.updateMany.mockResolvedValue({ count: 1 } as any);
  prismaMock.client.twoFactorAuth.deleteMany.mockResolvedValue({ count: 1 } as any);
  prismaMock.client.twoFactorBackupCode.deleteMany.mockResolvedValue({ count: 8 } as any);
  prismaMock.client.twoFactorOtpUsed.deleteMany.mockResolvedValue({ count: 2 } as any);
  prismaMock.client.twoFactorRateLimit.deleteMany.mockResolvedValue({ count: 1 } as any);
  prismaMock.transaction.mockImplementation(async callback => callback(prismaMock.client));

  const response = await DELETE(
    new Request('http://localhost/api/admin/users/user-1/2fa', { method: 'DELETE' }),
    {
      params: Promise.resolve({ userId: 'user-1' }),
    },
  );

  expect(prismaMock.client.twoFactorAuth.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'user-1' },
  });
  expect(prismaMock.client.user.updateMany).toHaveBeenCalledWith({
    where: { id: 'user-1', deletedAt: null },
    data: { sessionGeneration: { increment: 1 } },
  });
  expect(prismaMock.client.apiKey.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'user-1' },
  });
  expect(prismaMock.client.twoFactorBackupCode.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'user-1' },
  });
  expect(prismaMock.client.twoFactorOtpUsed.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'user-1' },
  });
  expect(prismaMock.client.twoFactorRateLimit.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'user-1' },
  });
  await expect(response.json()).resolves.toEqual({
    ok: true,
    userId: 'user-1',
    reset: {
      twoFactorAuth: 1,
      backupCodes: 8,
      otpUsed: 2,
      rateLimit: 1,
    },
  });
  expect(response.status).toBe(200);
});

test('DELETE without an enrolled factor does not revoke unrelated sessions', async () => {
  prismaMock.client.twoFactorAuth.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.client.twoFactorBackupCode.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.client.twoFactorOtpUsed.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.client.twoFactorRateLimit.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.transaction.mockImplementation(async callback => callback(prismaMock.client));

  const response = await DELETE(
    new Request('http://localhost/api/admin/users/user-1/2fa', { method: 'DELETE' }),
    { params: Promise.resolve({ userId: 'user-1' }) },
  );

  expect(response.status).toBe(200);
  expect(prismaMock.client.user.updateMany).not.toHaveBeenCalled();
  expect(prismaMock.client.apiKey.deleteMany).not.toHaveBeenCalled();
});

test('DELETE rejects a demoted administrator before resetting a factor', async () => {
  prismaMock.client.$queryRaw.mockReset().mockResolvedValue([]);
  prismaMock.client.twoFactorAuth.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.client.twoFactorBackupCode.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.client.twoFactorOtpUsed.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.client.twoFactorRateLimit.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.transaction.mockImplementation(async callback => callback(prismaMock.client));

  const response = await DELETE(
    new Request('http://localhost/api/admin/users/user-1/2fa', { method: 'DELETE' }),
    { params: Promise.resolve({ userId: 'user-1' }) },
  );

  expect(response.status).toBe(401);
  expect(prismaMock.client.twoFactorAuth.deleteMany).not.toHaveBeenCalled();
  expect(prismaMock.client.twoFactorBackupCode.deleteMany).not.toHaveBeenCalled();
  expect(prismaMock.client.twoFactorOtpUsed.deleteMany).not.toHaveBeenCalled();
  expect(prismaMock.client.twoFactorRateLimit.deleteMany).not.toHaveBeenCalled();
});

test('DELETE leaves a deleted target untouched', async () => {
  prismaMock.client.user.findFirst.mockImplementation(async ({ where }) =>
    where.role === 'admin' ? { id: 'admin-1' } : null,
  );

  const response = await DELETE(
    new Request('http://localhost/api/admin/users/user-1/2fa', { method: 'DELETE' }),
    { params: Promise.resolve({ userId: 'user-1' }) },
  );

  expect(response.status).toBe(404);
  expect(prismaMock.client.twoFactorAuth.deleteMany).not.toHaveBeenCalled();
});
