import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { getEntity } from '@/lib/entity';
import { getTeamUser, getWebsite } from '@/queries/prisma';
import {
  canCreateWebsite,
  canDeleteWebsite,
  canTransferWebsiteToTeam,
  canTransferWebsiteToUser,
  canUpdateWebsite,
  canViewAllWebsites,
  canViewBatchWebsites,
  canViewWebsite,
  redactWebsiteListShareIds,
} from './website';

const {
  websiteFindManyMock,
  teamUserFindManyMock,
  primaryWebsiteFindManyMock,
  primaryTeamUserFindManyMock,
} = vi.hoisted(() => ({
  websiteFindManyMock: vi.fn(),
  teamUserFindManyMock: vi.fn(),
  primaryWebsiteFindManyMock: vi.fn(),
  primaryTeamUserFindManyMock: vi.fn(),
}));

vi.mock('@/lib/entity', () => ({
  getEntity: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  getWebsite: vi.fn(),
  getTeamUser: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      website: {
        findMany: websiteFindManyMock,
      },
      teamUser: {
        findMany: teamUserFindManyMock,
      },
      $primary: () => ({
        website: { findMany: primaryWebsiteFindManyMock },
        teamUser: { findMany: primaryTeamUserFindManyMock },
      }),
    },
  },
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
  vi.mocked(getEntity).mockReset();
  vi.mocked(getWebsite).mockReset();
  vi.mocked(getTeamUser).mockReset();
  websiteFindManyMock.mockReset();
  teamUserFindManyMock.mockReset();
  primaryWebsiteFindManyMock.mockReset();
  primaryTeamUserFindManyMock.mockReset();
});

describe('canViewWebsite', () => {
  test('allows admins when the entity exists', async () => {
    vi.mocked(getEntity).mockResolvedValue({ userId: 'user-1' } as any);

    await expect(canViewWebsite({ user: adminUser }, 'website-1')).resolves.toBe(true);
    expect(getEntity).toHaveBeenCalledWith('website-1');
  });

  test('allows a matching single share token id', async () => {
    await expect(
      canViewWebsite(
        { shareToken: { shareType: ENTITY_TYPE.website, websiteId: 'website-1' } },
        'website-1',
      ),
    ).resolves.toBe(true);
  });

  test('does not promote non-website share identifiers to website permission', async () => {
    for (const shareToken of [
      { shareType: ENTITY_TYPE.board, websiteIds: ['website-1'], scopedApiAccess: true },
      { shareType: ENTITY_TYPE.pixel, pixelId: 'website-1', scopedApiAccess: true },
      { shareType: ENTITY_TYPE.link, linkId: 'website-1', scopedApiAccess: true },
    ]) {
      await expect(canViewWebsite({ shareToken }, 'website-1')).resolves.toBe(false);
    }
  });

  test('denies when entity is missing', async () => {
    vi.mocked(getEntity).mockResolvedValue(null as any);
    await expect(canViewWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });

  test('denies when there is no user and no matching share token', async () => {
    vi.mocked(getEntity).mockResolvedValue({ userId: 'user-1' } as any);
    await expect(canViewWebsite({}, 'website-1')).resolves.toBe(false);
  });

  test('allows the owner of a user-owned website', async () => {
    vi.mocked(getEntity).mockResolvedValue({ userId: 'user-1' } as any);
    await expect(canViewWebsite({ user: normalUser }, 'website-1')).resolves.toBe(true);
  });

  test('denies a non-owner of a user-owned website', async () => {
    vi.mocked(getEntity).mockResolvedValue({ userId: 'other-user' } as any);
    await expect(canViewWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });

  test('allows a member of the owning team', async () => {
    vi.mocked(getEntity).mockResolvedValue({ teamId: 'team-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    await expect(canViewWebsite({ user: normalUser }, 'website-1')).resolves.toBe(true);
  });

  test('denies a non-member of the owning team', async () => {
    vi.mocked(getEntity).mockResolvedValue({ teamId: 'team-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue(null as any);
    await expect(canViewWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });

  test('denies when entity has neither userId nor teamId', async () => {
    vi.mocked(getEntity).mockResolvedValue({} as any);
    await expect(canViewWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });
});

describe('canViewBatchWebsites', () => {
  test('returns empty array for empty input', async () => {
    await expect(canViewBatchWebsites({ user: normalUser }, [])).resolves.toEqual([]);
  });

  test('returns all deduped ids for admins', async () => {
    await expect(canViewBatchWebsites({ user: adminUser }, ['a', 'a', 'b'])).resolves.toEqual([
      'a',
      'b',
    ]);
  });

  test('returns only share-allowed ids when there is no user', async () => {
    await expect(
      canViewBatchWebsites({ shareToken: { shareType: ENTITY_TYPE.website, websiteId: 'a' } }, [
        'a',
        'b',
      ]),
    ).resolves.toEqual(['a']);
    await expect(
      canViewBatchWebsites(
        {
          shareToken: {
            shareType: ENTITY_TYPE.board,
            websiteIds: ['a'],
            scopedApiAccess: true,
          },
        },
        ['a', 'b'],
      ),
    ).resolves.toEqual([]);
  });

  test('returns owned, team, and share allowed ids for a user', async () => {
    primaryWebsiteFindManyMock.mockResolvedValue([
      { id: 'owned', userId: 'user-1', teamId: null },
      { id: 'team', userId: null, teamId: 'team-1' },
      { id: 'foreign', userId: 'other', teamId: null },
    ] as any);
    primaryTeamUserFindManyMock.mockResolvedValue([{ teamId: 'team-1' }] as any);

    await expect(
      canViewBatchWebsites(
        { user: normalUser, shareToken: { shareType: ENTITY_TYPE.website, websiteId: 'shared' } },
        ['owned', 'team', 'foreign', 'shared'],
      ),
    ).resolves.toEqual(['owned', 'team', 'shared']);
  });

  test('excludes team websites when the user is not a team member', async () => {
    primaryWebsiteFindManyMock.mockResolvedValue([
      { id: 'team', userId: null, teamId: 'team-1' },
    ] as any);
    primaryTeamUserFindManyMock.mockResolvedValue([] as any);

    await expect(canViewBatchWebsites({ user: normalUser }, ['team'])).resolves.toEqual([]);
  });

  test('does not authorize stale replica website ownership', async () => {
    websiteFindManyMock.mockResolvedValue([{ id: 'old', userId: 'user-1' }] as any);
    primaryWebsiteFindManyMock.mockResolvedValue([{ id: 'old', userId: 'new-owner' }] as any);

    await expect(canViewBatchWebsites({ user: normalUser }, ['old'])).resolves.toEqual([]);
    expect(websiteFindManyMock).not.toHaveBeenCalled();
  });
});

describe('redactWebsiteListShareIds', () => {
  const websites = [
    { id: 'owned', userId: 'user-1', teamId: null, shareId: 'owned-slug' },
    { id: 'managed-team', userId: null, teamId: 'team-1', shareId: 'managed-slug' },
    { id: 'read-only-team', userId: null, teamId: 'team-2', shareId: 'read-only-slug' },
    { id: 'foreign', userId: 'other', teamId: null, shareId: 'foreign-slug' },
  ];

  beforeEach(() => {
    primaryWebsiteFindManyMock.mockResolvedValue(websites);
  });

  test('does not disclose slugs to a downgraded owner or an API key', async () => {
    for (const auth of [
      { authType: 'session' as const, user: { ...viewOnlyUser, id: 'user-1' } },
      { authType: 'api-key' as const, user: normalUser },
    ]) {
      const result = await redactWebsiteListShareIds(auth, websites);
      expect(result.map(website => website.shareId)).toEqual([null, null, null, null]);
    }

    expect(primaryWebsiteFindManyMock).not.toHaveBeenCalled();
    expect(primaryTeamUserFindManyMock).not.toHaveBeenCalled();
  });

  test('preserves only slugs for websites the actor can currently update', async () => {
    primaryTeamUserFindManyMock.mockResolvedValue([
      { teamId: 'team-1', role: 'team-manager' },
      { teamId: 'team-2', role: 'team-view-only' },
    ] as any);

    const result = await redactWebsiteListShareIds(
      { authType: 'session', user: normalUser },
      websites,
    );

    expect(result.map(website => website.shareId)).toEqual([
      'owned-slug',
      'managed-slug',
      null,
      null,
    ]);
    expect(primaryWebsiteFindManyMock).toHaveBeenCalledWith({
      where: {
        id: { in: ['owned', 'managed-team', 'read-only-team', 'foreign'] },
        deletedAt: null,
      },
      select: { id: true, userId: true, teamId: true },
    });
    expect(primaryTeamUserFindManyMock).toHaveBeenCalledTimes(1);
    expect(primaryTeamUserFindManyMock).toHaveBeenCalledWith({
      where: {
        userId: normalUser.id,
        teamId: { in: ['team-1', 'team-2'] },
        team: { deletedAt: null },
        user: { deletedAt: null },
      },
      select: { teamId: true, role: true },
    });
    expect(websites[2].shareId).toBe('read-only-slug');
  });

  test('ignores stale replica ownership and team membership after access changes', async () => {
    primaryWebsiteFindManyMock.mockResolvedValue([
      { id: 'owned', userId: 'new-owner', teamId: null },
      { id: 'managed-team', userId: null, teamId: 'team-1' },
    ] as any);
    primaryTeamUserFindManyMock.mockResolvedValue([] as any);

    const result = await redactWebsiteListShareIds(
      { authType: 'session', user: normalUser },
      websites,
    );

    expect(result.map(website => website.shareId)).toEqual([null, null, null, null]);
    expect(websiteFindManyMock).not.toHaveBeenCalled();
    expect(teamUserFindManyMock).not.toHaveBeenCalled();
  });

  test('preserves slugs for an interactive administrator only', async () => {
    await expect(
      redactWebsiteListShareIds({ authType: 'session', user: adminUser }, websites),
    ).resolves.toEqual(websites);
    await expect(
      redactWebsiteListShareIds(
        { authType: 'session', user: { ...adminUser, role: 'view-only' } },
        websites,
      ),
    ).resolves.toEqual(websites.map(website => ({ ...website, shareId: null })));
  });
});

describe('canViewAllWebsites', () => {
  test('allows admins', async () => {
    await expect(canViewAllWebsites({ user: adminUser })).resolves.toBe(true);
  });

  test('denies non-admins', async () => {
    await expect(canViewAllWebsites({ user: normalUser })).resolves.toBe(false);
  });

  test('denies when there is no user', async () => {
    await expect(canViewAllWebsites({})).resolves.toBe(false);
  });
});

describe('canCreateWebsite', () => {
  test('denies when there is no user', async () => {
    await expect(canCreateWebsite({})).resolves.toBe(false);
  });

  test('allows admins', async () => {
    await expect(canCreateWebsite({ user: adminUser })).resolves.toBe(true);
  });

  test('allows a user role', async () => {
    await expect(canCreateWebsite({ user: normalUser })).resolves.toBe(true);
  });

  test('denies a view-only role', async () => {
    await expect(canCreateWebsite({ user: viewOnlyUser })).resolves.toBe(false);
  });
});

describe('canUpdateWebsite', () => {
  test('denies when there is no user', async () => {
    await expect(canUpdateWebsite({}, 'website-1')).resolves.toBe(false);
  });

  test('allows admins', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'user-1' } as any);

    await expect(canUpdateWebsite({ user: adminUser }, 'website-1')).resolves.toBe(true);
  });

  test('denies when website is missing', async () => {
    vi.mocked(getWebsite).mockResolvedValue(null as any);
    await expect(canUpdateWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });

  test('allows the owner of a user-owned website', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'user-1' } as any);
    await expect(canUpdateWebsite({ user: normalUser }, 'website-1')).resolves.toBe(true);
  });

  test('denies a non-owner of a user-owned website', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'other' } as any);
    await expect(canUpdateWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });

  test('allows a team member with website:update permission', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ teamId: 'team-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    await expect(canUpdateWebsite({ user: normalUser }, 'website-1')).resolves.toBe(true);
  });

  test('denies a team-view-only member', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ teamId: 'team-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-view-only' } as any);
    await expect(canUpdateWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });
});

describe('canDeleteWebsite', () => {
  test('denies when there is no user', async () => {
    await expect(canDeleteWebsite({}, 'website-1')).resolves.toBe(false);
  });

  test('allows admins', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'user-1' } as any);

    await expect(canDeleteWebsite({ user: adminUser }, 'website-1')).resolves.toBe(true);
  });

  test('denies when website is missing', async () => {
    vi.mocked(getWebsite).mockResolvedValue(null as any);
    await expect(canDeleteWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });

  test('allows the owner of a user-owned website', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'user-1' } as any);
    await expect(canDeleteWebsite({ user: normalUser }, 'website-1')).resolves.toBe(true);
  });

  test('allows a team member with website:delete permission', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ teamId: 'team-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    await expect(canDeleteWebsite({ user: normalUser }, 'website-1')).resolves.toBe(true);
  });

  test('denies a team-view-only member', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ teamId: 'team-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-view-only' } as any);
    await expect(canDeleteWebsite({ user: normalUser }, 'website-1')).resolves.toBe(false);
  });
});

describe('canTransferWebsiteToUser', () => {
  test('denies when there is no user', async () => {
    await expect(canTransferWebsiteToUser({}, 'website-1', 'user-1')).resolves.toBe(false);
  });

  test('denies when website is missing', async () => {
    vi.mocked(getWebsite).mockResolvedValue(null as any);
    await expect(
      canTransferWebsiteToUser({ user: normalUser }, 'website-1', 'user-1'),
    ).resolves.toBe(false);
  });

  test('allows admins without any lookup', async () => {
    await expect(
      canTransferWebsiteToUser({ user: adminUser }, 'website-1', 'admin-1'),
    ).resolves.toBe(true);
    expect(getWebsite).not.toHaveBeenCalled();
  });

  test('allows a team owner transferring a team website to themselves', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ teamId: 'team-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-owner' } as any);
    await expect(
      canTransferWebsiteToUser({ user: normalUser }, 'website-1', 'user-1'),
    ).resolves.toBe(true);
  });

  test('denies a team manager (lacks website:transfer-to-user)', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ teamId: 'team-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-manager' } as any);
    await expect(
      canTransferWebsiteToUser({ user: normalUser }, 'website-1', 'user-1'),
    ).resolves.toBe(false);
  });

  test('denies transferring to a different user id', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ teamId: 'team-1' } as any);
    await expect(
      canTransferWebsiteToUser({ user: normalUser }, 'website-1', 'other-user'),
    ).resolves.toBe(false);
  });
});

describe('canTransferWebsiteToTeam', () => {
  test('denies when there is no user', async () => {
    await expect(canTransferWebsiteToTeam({}, 'website-1', 'team-1')).resolves.toBe(false);
  });

  test('allows admins without any lookup', async () => {
    await expect(
      canTransferWebsiteToTeam({ user: adminUser }, 'website-1', 'team-1'),
    ).resolves.toBe(true);
    expect(getWebsite).not.toHaveBeenCalled();
  });

  test('denies when website is missing', async () => {
    vi.mocked(getWebsite).mockResolvedValue(null as any);
    await expect(
      canTransferWebsiteToTeam({ user: normalUser }, 'website-1', 'team-1'),
    ).resolves.toBe(false);
  });

  test('allows an owner who is a team owner of the destination team', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'user-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-owner' } as any);
    await expect(
      canTransferWebsiteToTeam({ user: normalUser }, 'website-1', 'team-1'),
    ).resolves.toBe(true);
  });

  test('allows an owner who is a team manager of the destination team', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'user-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-manager' } as any);
    await expect(
      canTransferWebsiteToTeam({ user: normalUser }, 'website-1', 'team-1'),
    ).resolves.toBe(true);
  });

  test('denies a team member of the destination team', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'user-1' } as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-member' } as any);
    await expect(
      canTransferWebsiteToTeam({ user: normalUser }, 'website-1', 'team-1'),
    ).resolves.toBe(false);
  });

  test('denies when the website is not owned by the user', async () => {
    vi.mocked(getWebsite).mockResolvedValue({ userId: 'other' } as any);
    await expect(
      canTransferWebsiteToTeam({ user: normalUser }, 'website-1', 'team-1'),
    ).resolves.toBe(false);
  });
});

test('globally view-only website owners and team owners cannot mutate websites', async () => {
  for (const website of [{ userId: viewOnlyUser.id }, { teamId: 'team-1' }]) {
    vi.mocked(getWebsite).mockResolvedValue(website as any);
    vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-owner' } as any);

    await expect(canUpdateWebsite({ user: viewOnlyUser }, 'website-1')).resolves.toBe(false);
    await expect(canDeleteWebsite({ user: viewOnlyUser }, 'website-1')).resolves.toBe(false);
    await expect(
      canTransferWebsiteToUser({ user: viewOnlyUser }, 'website-1', viewOnlyUser.id),
    ).resolves.toBe(false);
    await expect(
      canTransferWebsiteToTeam({ user: viewOnlyUser }, 'website-1', 'team-1'),
    ).resolves.toBe(false);
  }

  expect(getWebsite).not.toHaveBeenCalled();
  expect(getTeamUser).not.toHaveBeenCalled();
});
