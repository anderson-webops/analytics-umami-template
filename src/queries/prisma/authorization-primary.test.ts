import { beforeEach, expect, test, vi } from 'vitest';
import { getTeamUser } from './teamUser';
import { getWebsite } from './website';

const {
  primaryWebsiteFindUnique,
  replicaWebsiteFindUnique,
  primaryTeamUserFindFirst,
  replicaTeamUserFindFirst,
  primaryShareFindMany,
} = vi.hoisted(() => ({
  primaryWebsiteFindUnique: vi.fn(),
  replicaWebsiteFindUnique: vi.fn(),
  primaryTeamUserFindFirst: vi.fn(),
  replicaTeamUserFindFirst: vi.fn(),
  primaryShareFindMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({
        website: { findUnique: primaryWebsiteFindUnique },
        teamUser: { findFirst: primaryTeamUserFindFirst },
        share: { findMany: primaryShareFindMany },
      }),
      website: { findUnique: replicaWebsiteFindUnique },
      teamUser: { findFirst: replicaTeamUserFindFirst },
    },
  },
}));

beforeEach(() => {
  primaryWebsiteFindUnique.mockReset();
  replicaWebsiteFindUnique.mockReset();
  primaryTeamUserFindFirst.mockReset();
  replicaTeamUserFindFirst.mockReset();
  primaryShareFindMany.mockReset();
});

test('website detail uses current primary ownership before share readback', async () => {
  const websiteId = '508ad3c6-1993-41aa-a07c-44ff09a64686';
  replicaWebsiteFindUnique.mockResolvedValue({ id: websiteId, userId: 'old-owner' });
  primaryWebsiteFindUnique.mockResolvedValue({ id: websiteId, userId: 'new-owner' });
  primaryShareFindMany.mockResolvedValue([{ slug: 'current-share' }]);

  await expect(getWebsite(websiteId)).resolves.toMatchObject({
    userId: 'new-owner',
    shareId: 'current-share',
  });
  expect(replicaWebsiteFindUnique).not.toHaveBeenCalled();
  expect(primaryWebsiteFindUnique).toHaveBeenCalledWith({
    where: { id: websiteId, deletedAt: null },
  });
});

test('removed team membership cannot be resurrected by a lagging replica', async () => {
  const teamId = '72f6f1d5-b186-452c-928f-d00aaaf9c1e9';
  const userId = '1fe212a6-729b-4463-9bb2-621183d894c2';
  replicaTeamUserFindFirst.mockResolvedValue({ teamId, userId, role: 'team-manager' });
  primaryTeamUserFindFirst.mockResolvedValue(null);

  await expect(getTeamUser(teamId, userId)).resolves.toBeNull();
  expect(replicaTeamUserFindFirst).not.toHaveBeenCalled();
  expect(primaryTeamUserFindFirst).toHaveBeenCalledWith({
    where: {
      teamId,
      userId,
      team: { deletedAt: null },
      user: { deletedAt: null },
    },
  });
});
