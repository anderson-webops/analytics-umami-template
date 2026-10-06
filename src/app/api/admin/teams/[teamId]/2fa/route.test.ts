import { beforeEach, expect, test, vi } from 'vitest';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { canEnforceTwoFactorAuthForTeam } from '@/permissions';
import { POST } from './route';

vi.mock('@/lib/env', () => ({ isEnvEnabled: vi.fn(() => false) }));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({ canEnforceTwoFactorAuthForTeam: vi.fn() }));
vi.mock('@/lib/two-factor/crypto', () => ({
  getTwoFactorConfigurationError: () => ({ code: 'two-factor-error-not-configured' }),
  isTwoFactorConfigured: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $queryRaw: vi.fn(),
      user: { findFirst: vi.fn() },
      team: { updateMany: vi.fn() },
    },
    transaction: vi.fn(),
  },
}));

const prismaMock = prisma as any;
const context = { params: Promise.resolve({ teamId: 'team-1' }) };

beforeEach(() => {
  vi.mocked(parseRequest).mockReset();
  vi.mocked(canEnforceTwoFactorAuthForTeam).mockReset();
  vi.mocked(isTwoFactorConfigured).mockReset();
  prismaMock.client.$queryRaw.mockReset();
  prismaMock.client.user.findFirst.mockReset();
  prismaMock.client.team.updateMany.mockReset();
  prismaMock.transaction.mockReset();

  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'admin-1', isAdmin: true } },
    body: { required: false },
    error: undefined,
  } as any);
  vi.mocked(canEnforceTwoFactorAuthForTeam).mockResolvedValue(true);
  vi.mocked(isTwoFactorConfigured).mockReturnValue(true);
  prismaMock.client.$queryRaw.mockResolvedValueOnce([]).mockResolvedValue([{ allowed: 1 }]);
  prismaMock.client.team.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.transaction.mockImplementation(async callback => callback(prismaMock.client));
});

test('updates an active team after current administrator revalidation', async () => {
  const response = await POST(
    new Request('http://localhost/api/admin/teams/team-1/2fa', { method: 'POST' }),
    context,
  );

  expect(response.status).toBe(200);
  expect(prismaMock.client.team.updateMany).toHaveBeenCalledWith({
    where: { id: 'team-1', deletedAt: null },
    data: { twoFactorRequired: false },
  });
  await expect(response.json()).resolves.toEqual({
    ok: true,
    teamId: 'team-1',
    twoFactorRequired: false,
  });
});

test('does not change team policy after administrator demotion', async () => {
  prismaMock.client.$queryRaw.mockReset().mockResolvedValue([]);

  const response = await POST(
    new Request('http://localhost/api/admin/teams/team-1/2fa', { method: 'POST' }),
    context,
  );

  expect(response.status).toBe(401);
  expect(prismaMock.client.team.updateMany).not.toHaveBeenCalled();
});

test('does not change policy for a deleted team', async () => {
  prismaMock.client.team.updateMany.mockResolvedValue({ count: 0 });

  const response = await POST(
    new Request('http://localhost/api/admin/teams/team-1/2fa', { method: 'POST' }),
    context,
  );

  expect(response.status).toBe(404);
  expect(prismaMock.client.team.updateMany).toHaveBeenCalledWith({
    where: { id: 'team-1', deletedAt: null },
    data: { twoFactorRequired: false },
  });
});
