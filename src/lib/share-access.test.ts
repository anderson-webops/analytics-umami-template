import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Board, Share } from '@/generated/prisma/client';
import { ENTITY_TYPE } from '@/lib/constants';
import { getBoard } from '@/queries/prisma';
import { resolveShareAccess } from './share-access';

const mocks = vi.hoisted(() => ({
  websites: vi.fn(),
  pixels: vi.fn(),
  links: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({
        website: { findMany: mocks.websites },
        pixel: { findMany: mocks.pixels },
        link: { findMany: mocks.links },
      }),
    },
  },
}));

vi.mock('@/queries/prisma', () => ({
  getBoard: vi.fn(),
  getWebsite: vi.fn(),
  getPixel: vi.fn(),
  getLink: vi.fn(),
}));

function uuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function boardFor(
  ids: { type: string; id: string }[],
  owner: { userId: string | null; teamId: string | null },
) {
  return {
    ...owner,
    type: 'mixed',
    parameters: {
      rows: Array.from({ length: Math.ceil(ids.length / 4) }, (_, index) => ({
        columns: ids.slice(index * 4, index * 4 + 4).map(({ type, id }) => ({
          component: { type: 'WebsiteChart', entityType: type, entityId: id },
        })),
      })),
    },
  } as unknown as Board;
}

function share() {
  return {
    id: uuid(999),
    entityId: uuid(998),
    shareType: ENTITY_TYPE.board,
    parameters: {},
  } as Pick<Share, 'id' | 'entityId' | 'shareType' | 'parameters'>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('board share entity resolution', () => {
  test('resolves a maximum-sized board with one database read per populated entity type', async () => {
    const websiteIds = Array.from({ length: 200 }, (_, index) => uuid(index + 1));
    vi.mocked(getBoard).mockResolvedValue(
      boardFor(
        websiteIds.map(id => ({ type: 'website', id })),
        { userId: 'owner', teamId: null },
      ),
    );
    mocks.websites.mockImplementation(async ({ where }) =>
      where.id.in.map((id: string) => ({ id, userId: 'owner', teamId: null, deletedAt: null })),
    );

    const access = await resolveShareAccess(share());

    expect(access?.data.websiteIds).toEqual(websiteIds);
    expect(mocks.websites).toHaveBeenCalledTimes(1);
    expect(mocks.websites.mock.calls[0][0]).toMatchObject({
      where: { id: { in: websiteIds }, deletedAt: null },
    });
    expect(mocks.pixels).not.toHaveBeenCalled();
    expect(mocks.links).not.toHaveBeenCalled();
  });

  test('keeps only current owner-matching entities and excludes malformed IDs', async () => {
    const websiteAllowed = uuid(1);
    const websiteOther = uuid(2);
    const pixelAllowed = uuid(3);
    const linkDeleted = uuid(4);
    vi.mocked(getBoard).mockResolvedValue(
      boardFor(
        [
          { type: 'website', id: websiteAllowed },
          { type: 'website', id: websiteOther },
          { type: 'website', id: 'invalid-id' },
          { type: 'pixel', id: pixelAllowed },
          { type: 'link', id: linkDeleted },
        ],
        { userId: null, teamId: 'team-a' },
      ),
    );
    mocks.websites.mockResolvedValue([
      { id: websiteAllowed, userId: null, teamId: 'team-a', deletedAt: null },
      { id: websiteOther, userId: null, teamId: 'team-b', deletedAt: null },
    ]);
    mocks.pixels.mockResolvedValue([
      { id: pixelAllowed, userId: null, teamId: 'team-a', deletedAt: null },
    ]);
    mocks.links.mockResolvedValue([
      { id: linkDeleted, userId: null, teamId: 'team-a', deletedAt: new Date() },
    ]);

    const access = await resolveShareAccess(share());

    expect(access?.data).toMatchObject({
      websiteIds: [websiteAllowed],
      pixelIds: [pixelAllowed],
      linkIds: [],
    });
    expect(mocks.websites.mock.calls[0][0].where.id.in).toEqual([websiteAllowed, websiteOther]);
    expect(mocks.links.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  test('fails closed for a failed entity read without widening other grants', async () => {
    const websiteId = uuid(1);
    const pixelId = uuid(2);
    vi.mocked(getBoard).mockResolvedValue(
      boardFor(
        [
          { type: 'website', id: websiteId },
          { type: 'pixel', id: pixelId },
        ],
        { userId: 'owner', teamId: null },
      ),
    );
    mocks.websites.mockRejectedValue(new Error('database unavailable'));
    mocks.pixels.mockResolvedValue([
      { id: pixelId, userId: 'owner', teamId: null, deletedAt: null },
    ]);

    const access = await resolveShareAccess(share());

    expect(access?.data.websiteIds).toEqual([]);
    expect(access?.data.pixelIds).toEqual([pixelId]);
    expect(mocks.websites).toHaveBeenCalledTimes(1);
    expect(mocks.pixels).toHaveBeenCalledTimes(1);
  });
});
