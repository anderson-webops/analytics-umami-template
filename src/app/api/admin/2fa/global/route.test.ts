import { beforeEach, expect, test, vi } from 'vitest';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { canEnforceTwoFactorAuthForEveryone } from '@/permissions';
import { POST } from './route';

vi.mock('@/lib/env', () => ({ isEnvEnabled: vi.fn(() => false) }));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({ canEnforceTwoFactorAuthForEveryone: vi.fn() }));
vi.mock('@/lib/two-factor/crypto', () => ({
  getTwoFactorConfigurationError: () => ({ code: 'two-factor-error-not-configured' }),
  isTwoFactorConfigured: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $queryRaw: vi.fn(),
      user: { findFirst: vi.fn() },
      appSetting: { upsert: vi.fn() },
    },
    transaction: vi.fn(),
  },
}));

const prismaMock = prisma as any;

beforeEach(() => {
  vi.mocked(parseRequest).mockReset();
  vi.mocked(canEnforceTwoFactorAuthForEveryone).mockReset();
  vi.mocked(isTwoFactorConfigured).mockReset();
  prismaMock.client.$queryRaw.mockReset();
  prismaMock.client.user.findFirst.mockReset();
  prismaMock.client.appSetting.upsert.mockReset();
  prismaMock.transaction.mockReset();

  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'admin-1', isAdmin: true } },
    body: { required: false },
    error: undefined,
  } as any);
  vi.mocked(canEnforceTwoFactorAuthForEveryone).mockResolvedValue(true);
  vi.mocked(isTwoFactorConfigured).mockReturnValue(true);
  prismaMock.client.$queryRaw.mockResolvedValueOnce([]).mockResolvedValue([{ allowed: 1 }]);
  prismaMock.transaction.mockImplementation(async callback => callback(prismaMock.client));
});

test('sets global policy only after current administrator revalidation', async () => {
  const response = await POST(
    new Request('http://localhost/api/admin/2fa/global', { method: 'POST' }),
  );

  expect(response.status).toBe(200);
  expect(prismaMock.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'Serializable',
    timeout: 30_000,
  });
  expect(prismaMock.client.$queryRaw).toHaveBeenCalledTimes(2);
  expect(prismaMock.client.$queryRaw.mock.calls[1][0].join('')).toContain('FOR UPDATE');
  expect(prismaMock.client.appSetting.upsert).toHaveBeenCalledWith({
    where: { key: 'twoFactorRequiredGlobal' },
    update: { value: 'false' },
    create: { key: 'twoFactorRequiredGlobal', value: 'false' },
  });
  await expect(response.json()).resolves.toEqual({ ok: true, required: false });
});

test('does not change global policy after administrator demotion', async () => {
  prismaMock.client.$queryRaw.mockReset().mockResolvedValue([]);

  const response = await POST(
    new Request('http://localhost/api/admin/2fa/global', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  expect(prismaMock.client.appSetting.upsert).not.toHaveBeenCalled();
});

test('does not enable global policy without two-factor configuration', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'admin-1', isAdmin: true } },
    body: { required: true },
    error: undefined,
  } as any);
  vi.mocked(isTwoFactorConfigured).mockReturnValue(false);

  const response = await POST(
    new Request('http://localhost/api/admin/2fa/global', { method: 'POST' }),
  );

  expect(response.status).toBe(503);
  expect(prismaMock.transaction).not.toHaveBeenCalled();
});
