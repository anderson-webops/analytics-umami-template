import { beforeEach, expect, test, vi } from 'vitest';
import { getLinks } from './link';
import { getPixel, getPixels } from './pixel';
import { getSharesByEntityId } from './share';
import { findTeam } from './team';

const {
  pagedQueryMock,
  primaryPixelFindUnique,
  primaryTeamFindUnique,
  replicaPixelFindUnique,
  replicaTeamFindUnique,
} = vi.hoisted(() => ({
  pagedQueryMock: vi.fn(),
  primaryPixelFindUnique: vi.fn(),
  primaryTeamFindUnique: vi.fn(),
  replicaPixelFindUnique: vi.fn(),
  replicaTeamFindUnique: vi.fn(),
}));

const ENTITY_ID = '3979e857-a987-4795-9380-12024a4440a9';

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      pixel: { findUnique: replicaPixelFindUnique },
      team: { findUnique: replicaTeamFindUnique },
      $primary: () => ({
        pixel: { findUnique: primaryPixelFindUnique },
        team: { findUnique: primaryTeamFindUnique },
      }),
    },
    getSearchParameters: vi.fn(() => ({})),
    pagedQuery: pagedQueryMock,
  },
}));

beforeEach(() => {
  pagedQueryMock.mockReset();
  pagedQueryMock.mockResolvedValue({ data: [], count: 0, page: 1, pageSize: 20 });
  primaryPixelFindUnique.mockReset();
  primaryTeamFindUnique.mockReset();
  replicaPixelFindUnique.mockReset();
  replicaTeamFindUnique.mockReset();
});

test('revoked pixel access ignores a stale replica owner', async () => {
  replicaPixelFindUnique.mockResolvedValue({ id: ENTITY_ID, userId: 'former-owner' });
  primaryPixelFindUnique.mockResolvedValue(null);

  await expect(getPixel(ENTITY_ID)).resolves.toBeNull();
  expect(primaryPixelFindUnique).toHaveBeenCalledWith({
    where: { id: ENTITY_ID, deletedAt: null },
  });
  expect(replicaPixelFindUnique).not.toHaveBeenCalled();
});

test('current pixel owner remains readable from the primary', async () => {
  const pixel = { id: ENTITY_ID, userId: 'current-owner' };
  primaryPixelFindUnique.mockResolvedValue(pixel);

  await expect(getPixel(ENTITY_ID)).resolves.toBe(pixel);
  expect(replicaPixelFindUnique).not.toHaveBeenCalled();
});

test('primary failure does not authorize from a stale pixel replica', async () => {
  replicaPixelFindUnique.mockResolvedValue({ id: ENTITY_ID, userId: 'former-owner' });
  primaryPixelFindUnique.mockRejectedValue(new Error('primary unavailable'));

  await expect(getPixel(ENTITY_ID)).rejects.toThrow('primary unavailable');
  expect(replicaPixelFindUnique).not.toHaveBeenCalled();
});

test('deleted team is not revived by a stale replica', async () => {
  replicaTeamFindUnique.mockResolvedValue({ id: ENTITY_ID });
  primaryTeamFindUnique.mockResolvedValue(null);

  await expect(findTeam({ where: { id: ENTITY_ID } })).resolves.toBeNull();
  expect(primaryTeamFindUnique).toHaveBeenCalledWith({
    where: { id: ENTITY_ID, deletedAt: null },
  });
  expect(replicaTeamFindUnique).not.toHaveBeenCalled();
});

test('ownership and share lists select primary-backed rows and counts', async () => {
  await getPixels({ where: { userId: 'former-owner' } });
  await getLinks({ where: { userId: 'former-owner' } });
  await getSharesByEntityId(ENTITY_ID);

  expect(pagedQueryMock).toHaveBeenCalledTimes(3);
  for (const [index, model] of ['pixel', 'link', 'share'].entries()) {
    expect(pagedQueryMock.mock.calls[index]?.[0]).toBe(model);
    expect(pagedQueryMock.mock.calls[index]?.[3]).toEqual({ usePrimary: true });
  }
});
