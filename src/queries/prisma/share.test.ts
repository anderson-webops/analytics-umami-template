import { beforeEach, expect, test, vi } from 'vitest';
import { getShare, getShareByCode } from './share';

const { primaryFindUnique, replicaFindUnique } = vi.hoisted(() => ({
  primaryFindUnique: vi.fn(),
  replicaFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({ share: { findUnique: primaryFindUnique } }),
      share: { findUnique: replicaFindUnique },
    },
  },
}));

beforeEach(() => {
  primaryFindUnique.mockReset();
  replicaFindUnique.mockReset();
});

test('revoked bearer links and tokens do not trust a lagging replica', async () => {
  const shareId = '26a3b489-e0ee-4ba8-9b4d-f47b3efcd699';
  replicaFindUnique.mockResolvedValue({ id: shareId, slug: 'revoked-share' });
  primaryFindUnique.mockResolvedValue(null);

  expect(await getShareByCode('revoked-share')).toBeNull();
  expect(await getShare(shareId)).toBeNull();
  expect(primaryFindUnique).toHaveBeenCalledWith({ where: { slug: 'revoked-share' } });
  expect(primaryFindUnique).toHaveBeenCalledWith({ where: { id: shareId } });
  expect(replicaFindUnique).not.toHaveBeenCalled();
});

test('active bearer links still resolve from the primary', async () => {
  const share = { id: '26a3b489-e0ee-4ba8-9b4d-f47b3efcd699', slug: 'active-share' };
  primaryFindUnique.mockResolvedValue(share);

  expect(await getShareByCode(share.slug)).toEqual(share);
  expect(replicaFindUnique).not.toHaveBeenCalled();
});
