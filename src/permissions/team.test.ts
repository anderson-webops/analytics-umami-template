import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getBillingAccess, getTeamBillingScope } from '@/lib/load';
import { getTeam, getTeamUser } from '@/queries/prisma';
import {
  canCreateTeam,
  canCreateTeamWebsite,
  canDeleteTeam,
  canDeleteTeamUser,
  canEnforceTwoFactorAuthForTeam,
  canTransferTeamOwnership,
  canUpdateTeam,
  canUpdateTeamWebsites,
  canViewAllTeams,
  canViewTeam,
  canViewTeamSubscription,
} from './team';

vi.mock('@/queries/prisma', () => ({
  getTeam: vi.fn(),
  getTeamUser: vi.fn(),
}));

vi.mock('@/lib/load', () => ({
  getBillingAccess: vi.fn(),
  getTeamBillingScope: vi.fn(),
}));

vi.mock('@/lib/auth', async () => {
  const { ROLE_PERMISSIONS } = await import('@/lib/constants');

  return {
    hasPermission: (role: string, permission: string | string[]) =>
      (Array.isArray(permission) ? permission : [permission]).some(p =>
        ROLE_PERMISSIONS[role]?.includes(p),
      ),
  };
});

const adminUser = { id: 'admin-1', username: 'admin', role: 'admin', isAdmin: true };
const normalUser = { id: 'user-1', username: 'user', role: 'user', isAdmin: false };
const viewOnlyUser = { id: 'user-2', username: 'viewer', role: 'view-only', isAdmin: false };

beforeEach(() => {
  vi.mocked(getTeam).mockReset();
  vi.mocked(getTeam).mockResolvedValue({ id: 'team-1' } as any);
  vi.mocked(getTeamUser).mockReset();
  vi.mocked(getBillingAccess).mockResolvedValue({ isPastDue: false, isOwner: false });
  vi.mocked(getTeamBillingScope).mockResolvedValue({ accountId: 'owner-1', teamId: 'team-1' });
});

describe('canViewTeam', () => {
  test('denies when there is no user', async () => {
    await expect(canViewTeam({}, 'team-1')).resolves.toBe(false);
  });

  test('allows admins without a membership lookup', async () => {
    await expect(canViewTeam({ user: adminUser }, 'team-1')).resolves.toBe(true);
    expect(getTeamUser).not.toHaveBeenCalled();
  });

  test('allows a team member when the team is current', async () => {
    const membership = { role: 'team-member' };
    vi.mocked(getTeamUser).mockResolvedValue(membership as any);
    await expect(canViewTeam({ user: normalUser }, 'team-1')).resolves.toBe(true);
  });

  test('denies a non-member', async () => {
    vi.mocked(getTeamUser).mockResolvedValue(null as any);
    await expect(canViewTeam({ user: normalUser }, 'team-1')).resolves.toBe(false);
  });

  test('denies team members while the team is past due', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    vi.mocked(getBillingAccess).mockResolvedValue({ isPastDue: true, isOwner: false });

    await expect(canViewTeam({ user: normalUser }, 'team-1')).resolves.toBe(false);
  });

  test('allows the subscription lookup for a past-due team', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);

    await expect(canViewTeamSubscription({ user: normalUser }, 'team-1')).resolves.toBe(true);
  });
});

test('globally view-only users cannot mutate teams even with owner membership', async () => {
  vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-owner' } as any);

  for (const check of [
    () => canDeleteTeam({ user: viewOnlyUser }, 'team-1'),
    () => canDeleteTeamUser({ user: viewOnlyUser }, 'team-1', 'other-user'),
    () => canDeleteTeamUser({ user: viewOnlyUser }, 'team-1', viewOnlyUser.id),
    () => canTransferTeamOwnership({ user: viewOnlyUser }, 'team-1'),
    () => canCreateTeamWebsite({ user: viewOnlyUser }, 'team-1'),
    () => canUpdateTeamWebsites({ user: viewOnlyUser }, 'team-1'),
  ]) {
    await expect(check()).resolves.toBe(false);
  }

  expect(getTeamUser).not.toHaveBeenCalled();
});

describe('canCreateTeam', () => {
  test('denies when there is no user', async () => {
    await expect(canCreateTeam({})).resolves.toBe(false);
  });

  test('allows admins', async () => {
    await expect(canCreateTeam({ user: adminUser })).resolves.toBe(true);
  });

  test('allows a user role', async () => {
    await expect(canCreateTeam({ user: normalUser })).resolves.toBe(true);
  });

  test('denies a view-only role', async () => {
    await expect(canCreateTeam({ user: viewOnlyUser })).resolves.toBe(false);
  });
});

describe('canUpdateTeam', () => {
  test('denies when there is no user', async () => {
    await expect(canUpdateTeam({}, 'team-1')).resolves.toBe(false);
  });

  test('allows admins', async () => {
    await expect(canUpdateTeam({ user: adminUser }, 'team-1')).resolves.toBe(true);
  });

  test('allows a team owner', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-owner' } as any);
    await expect(canUpdateTeam({ user: normalUser }, 'team-1')).resolves.toBe(true);
  });

  test('allows a team manager', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-manager' } as any);
    await expect(canUpdateTeam({ user: normalUser }, 'team-1')).resolves.toBe(true);
  });

  test('denies a globally view-only team manager', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-manager' } as any);
    await expect(canUpdateTeam({ user: viewOnlyUser }, 'team-1')).resolves.toBe(false);
    expect(getTeamUser).not.toHaveBeenCalled();
  });

  test('denies a team member (lacks team:update)', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    await expect(canUpdateTeam({ user: normalUser }, 'team-1')).resolves.toBe(false);
  });

  test('denies a non-member', async () => {
    vi.mocked(getTeamUser).mockResolvedValue(null as any);
    await expect(canUpdateTeam({ user: normalUser }, 'team-1')).resolves.toBe(false);
  });
});

describe('canUpdateTeamWebsites', () => {
  test('requires an active user and a website-update membership', async () => {
    await expect(canUpdateTeamWebsites({}, 'team-1')).resolves.toBe(false);
    vi.mocked(getTeamUser).mockResolvedValue(null);
    await expect(canUpdateTeamWebsites({ user: normalUser }, 'team-1')).resolves.toBe(false);

    for (const role of ['team-view-only', 'team-member', 'team-manager']) {
      vi.mocked(getTeamUser).mockResolvedValue({ role } as any);
      await expect(canUpdateTeamWebsites({ user: normalUser }, 'team-1')).resolves.toBe(
        role !== 'team-view-only',
      );
    }
  });

  test('allows an administrator only for an existing team', async () => {
    await expect(canUpdateTeamWebsites({ user: adminUser }, 'team-1')).resolves.toBe(true);
    vi.mocked(getTeam).mockResolvedValue(null);
    await expect(canUpdateTeamWebsites({ user: adminUser }, 'team-1')).resolves.toBe(false);
  });
});

describe('canDeleteTeam', () => {
  test('denies when there is no user', async () => {
    await expect(canDeleteTeam({}, 'team-1')).resolves.toBe(false);
  });

  test('allows admins', async () => {
    await expect(canDeleteTeam({ user: adminUser }, 'team-1')).resolves.toBe(true);
  });

  test('allows a team owner', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-owner' } as any);
    await expect(canDeleteTeam({ user: normalUser }, 'team-1')).resolves.toBe(true);
  });

  test('denies a team manager (lacks team:delete)', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-manager' } as any);
    await expect(canDeleteTeam({ user: normalUser }, 'team-1')).resolves.toBe(false);
  });
});

describe('canDeleteTeamUser', () => {
  test('denies when there is no user', async () => {
    await expect(canDeleteTeamUser({}, 'team-1', 'remove-1')).resolves.toBe(false);
  });

  test('allows admins', async () => {
    await expect(canDeleteTeamUser({ user: adminUser }, 'team-1', 'remove-1')).resolves.toBe(true);
  });

  test('allows a user to remove themselves', async () => {
    await expect(canDeleteTeamUser({ user: normalUser }, 'team-1', 'user-1')).resolves.toBe(true);
    expect(getTeamUser).not.toHaveBeenCalled();
  });

  test('allows a team manager to remove another user', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-manager' } as any);
    await expect(canDeleteTeamUser({ user: normalUser }, 'team-1', 'other-user')).resolves.toBe(
      true,
    );
  });

  test('denies a team member removing another user', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    await expect(canDeleteTeamUser({ user: normalUser }, 'team-1', 'other-user')).resolves.toBe(
      false,
    );
  });
});

describe('canCreateTeamWebsite', () => {
  test('denies when there is no user', async () => {
    await expect(canCreateTeamWebsite({}, 'team-1')).resolves.toBe(false);
  });

  test('allows admins', async () => {
    await expect(canCreateTeamWebsite({ user: adminUser }, 'team-1')).resolves.toBe(true);
  });

  test('allows a team member with website:create', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    await expect(canCreateTeamWebsite({ user: normalUser }, 'team-1')).resolves.toBe(true);
  });

  test('denies a team-view-only member', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-view-only' } as any);
    await expect(canCreateTeamWebsite({ user: normalUser }, 'team-1')).resolves.toBe(false);
  });

  // Global view-only users must not create anything, even in a team they own.
  test('denies a globally view-only user who owns the team', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-owner' } as any);
    await expect(canCreateTeamWebsite({ user: viewOnlyUser }, 'team-1')).resolves.toBe(false);
  });

  // Team resources are billed to the team, so a past-due personal account must not block them.
  test('allows a member whose personal account is past due when the team is current', async () => {
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    vi.mocked(getBillingAccess).mockImplementation(async scope => ({
      isPastDue: scope.accountId === normalUser.id,
      isOwner: false,
    }));

    await expect(canCreateTeamWebsite({ user: normalUser }, 'team-1')).resolves.toBe(true);
  });
});

describe('canViewAllTeams', () => {
  test('allows admins', async () => {
    await expect(canViewAllTeams({ user: adminUser })).resolves.toBe(true);
  });

  test('denies non-admins', async () => {
    await expect(canViewAllTeams({ user: normalUser })).resolves.toBe(false);
  });

  test('denies when there is no user', async () => {
    await expect(canViewAllTeams({})).resolves.toBe(false);
  });
});

describe('canEnforceTwoFactorAuthForTeam', () => {
  test('denies when there is no user', async () => {
    await expect(canEnforceTwoFactorAuthForTeam({}, 'team-1')).resolves.toBe(false);
  });

  test('allows admins', async () => {
    await expect(canEnforceTwoFactorAuthForTeam({ user: adminUser }, 'team-1')).resolves.toBe(true);
  });

  test('denies admins for a missing team', async () => {
    vi.mocked(getTeam).mockResolvedValue(null as any);
    await expect(canEnforceTwoFactorAuthForTeam({ user: adminUser }, 'missing')).resolves.toBe(
      false,
    );
  });

  test('denies non-admins', async () => {
    await expect(canEnforceTwoFactorAuthForTeam({ user: normalUser }, 'team-1')).resolves.toBe(
      false,
    );
  });
});
