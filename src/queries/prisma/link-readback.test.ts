import { beforeEach, expect, test, vi } from 'vitest';
import { findLink } from './link';

const { primaryFindUnique, replicaFindUnique } = vi.hoisted(() => ({
  primaryFindUnique: vi.fn(),
  replicaFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({ link: { findUnique: primaryFindUnique } }),
      link: { findUnique: replicaFindUnique },
    },
  },
}));

beforeEach(() => {
  primaryFindUnique.mockReset();
  replicaFindUnique.mockReset();
});

test('link redirect authority uses the primary rather than a stale replica', async () => {
  const criteria = { where: { slug: 'public-link', deletedAt: null } };
  replicaFindUnique.mockResolvedValue({ id: 'link-1', url: 'https://old.example/' });
  primaryFindUnique.mockResolvedValue({ id: 'link-1', url: 'https://new.example/' });

  const link = await findLink(criteria);

  expect(link?.url).toBe('https://new.example/');
  expect(primaryFindUnique).toHaveBeenCalledWith(criteria);
  expect(replicaFindUnique).not.toHaveBeenCalled();
});
