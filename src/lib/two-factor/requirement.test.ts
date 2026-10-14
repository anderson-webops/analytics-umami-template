import { beforeEach, expect, test, vi } from 'vitest';
import { getTwoFactorRequirement } from './requirement';

const mocks = vi.hoisted(() => ({
  primary: vi.fn(),
  replicaSetting: vi.fn(),
  primarySetting: vi.fn(),
  primaryUser: vi.fn(),
  primaryMemberships: vi.fn(),
  primaryTeams: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: mocks.primary,
      appSetting: { findUnique: mocks.replicaSetting },
    },
  },
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  mocks.primary.mockReturnValue({
    appSetting: { findUnique: mocks.primarySetting },
    user: { findUnique: mocks.primaryUser },
    teamUser: { findMany: mocks.primaryMemberships },
    team: { findMany: mocks.primaryTeams },
  });
  mocks.primarySetting.mockResolvedValue(null);
  mocks.primaryUser.mockResolvedValue({ twoFactorRequired: false });
  mocks.primaryMemberships.mockResolvedValue([]);
  mocks.primaryTeams.mockResolvedValue([]);
});

test('reads global policy from primary rather than a stale replica', async () => {
  mocks.replicaSetting.mockResolvedValue(null);
  mocks.primarySetting.mockResolvedValue({ value: 'true' });

  expect(await getTwoFactorRequirement('user-1')).toEqual({
    reason: 'global',
    globalRequired: true,
  });
  expect(mocks.replicaSetting).not.toHaveBeenCalled();
});

test('reads a current user requirement and team membership from primary', async () => {
  mocks.primaryUser.mockResolvedValue({ twoFactorRequired: true });
  expect(await getTwoFactorRequirement('user-1')).toMatchObject({ reason: 'user' });

  mocks.primaryUser.mockResolvedValue({ twoFactorRequired: false });
  mocks.primaryMemberships.mockResolvedValue([{ teamId: 'team-1' }]);
  mocks.primaryTeams.mockResolvedValue([{ id: 'team-1' }]);
  expect(await getTwoFactorRequirement('user-1')).toMatchObject({ reason: 'team' });
});

test('does not invent a requirement when no policy applies', async () => {
  expect(await getTwoFactorRequirement('user-1')).toEqual({
    reason: null,
    globalRequired: false,
  });
});

test('checks an MFA requirement through the supplied mutation transaction', async () => {
  const transaction = {
    appSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ twoFactorRequired: true }) },
    teamUser: { findMany: vi.fn() },
    team: { findMany: vi.fn() },
  };

  expect(await getTwoFactorRequirement('user-1', transaction as never)).toMatchObject({
    reason: 'user',
  });
  expect(transaction.user.findUnique).toHaveBeenCalledWith({
    where: { id: 'user-1' },
    select: { twoFactorRequired: true },
  });
  expect(mocks.primary).not.toHaveBeenCalled();
});
