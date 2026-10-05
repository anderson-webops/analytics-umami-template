import { beforeEach, expect, test, vi } from 'vitest';
import { attachShareIdToWebsite, attachShareIdToWebsites } from './website';

const { primaryFindMany, primaryGroupBy, replicaFindMany, replicaGroupBy } = vi.hoisted(() => ({
  primaryFindMany: vi.fn(),
  primaryGroupBy: vi.fn(),
  replicaFindMany: vi.fn(),
  replicaGroupBy: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({
        share: { findMany: primaryFindMany, groupBy: primaryGroupBy },
      }),
      share: { findMany: replicaFindMany, groupBy: replicaGroupBy },
    },
  },
}));

beforeEach(() => {
  primaryFindMany.mockReset();
  primaryGroupBy.mockReset();
  replicaFindMany.mockReset();
  replicaGroupBy.mockReset();
});

test('single website share readback uses the primary after rotation', async () => {
  replicaFindMany.mockResolvedValue([{ slug: 'retired-link' }]);
  primaryFindMany.mockResolvedValue([{ slug: 'active-link' }]);

  const website = await attachShareIdToWebsite({ id: 'website-1' } as any);

  expect(website.shareId).toBe('active-link');
  expect(replicaFindMany).not.toHaveBeenCalled();
});

test('batch readback also uses the primary for a sole active share', async () => {
  primaryGroupBy.mockResolvedValue([{ entityId: 'website-1', _count: { _all: 1 } }]);
  primaryFindMany.mockResolvedValue([{ entityId: 'website-1', slug: 'active-link' }]);
  replicaFindMany.mockResolvedValue([{ entityId: 'website-1', slug: 'retired-link' }]);

  const result = await attachShareIdToWebsites({
    data: [{ id: 'website-1' }],
    count: 1,
    page: 1,
    pageSize: 10,
    orderBy: 'name',
    search: '',
  });

  expect(result.data[0].shareId).toBe('active-link');
  expect(replicaFindMany).not.toHaveBeenCalled();
});

test('batch readback does not present a singular slug for multiple active shares', async () => {
  primaryGroupBy.mockResolvedValue([{ entityId: 'website-1', _count: { _all: 2 } }]);
  replicaGroupBy.mockResolvedValue([{ entityId: 'website-1', _count: { _all: 1 } }]);

  const result = await attachShareIdToWebsites({
    data: [{ id: 'website-1' }],
    count: 1,
    page: 1,
    pageSize: 10,
    orderBy: 'name',
    search: '',
  });

  expect(result.data[0].shareId).toBeNull();
  expect(primaryFindMany).not.toHaveBeenCalled();
  expect(replicaGroupBy).not.toHaveBeenCalled();
});
