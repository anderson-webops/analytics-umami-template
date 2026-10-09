import { beforeEach, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import { canViewBoard, canViewLink, canViewPixel } from '@/permissions';
import { getBoard, getLink, getPixel } from '@/queries/prisma';
import { GET as getBoardRoute } from './boards/[boardId]/route';
import { GET as getLinkRoute } from './links/[linkId]/route';
import { GET as getPixelRoute } from './pixels/[pixelId]/route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewBoard: vi.fn(),
  canViewLink: vi.fn(),
  canViewPixel: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  getBoard: vi.fn(),
  getLink: vi.fn(),
  getPixel: vi.fn(),
}));

const entityId = '3979e857-a987-4795-9380-12024a4440a9';
const privateFields = { userId: 'owner-1', teamId: null };
const dates = { createdAt: '2026-01-01', updatedAt: '2026-01-02' };
const link = {
  id: entityId,
  name: 'Link',
  url: 'https://example.com',
  slug: 'link',
  ...dates,
  ...privateFields,
};
const pixel = { id: entityId, name: 'Pixel', slug: 'pixel', ...dates, ...privateFields };
const board = {
  id: entityId,
  type: 'mixed',
  name: 'Board',
  description: 'Shared board',
  parameters: { rows: [] },
  ...dates,
  ...privateFields,
};

beforeEach(() => {
  vi.clearAllMocks();
  const canView = async (auth: { user?: { id: string }; shareToken?: unknown }) =>
    !!auth.shareToken || auth.user?.id === 'owner-1';
  vi.mocked(canViewLink).mockImplementation(canView as any);
  vi.mocked(canViewPixel).mockImplementation(canView as any);
  vi.mocked(canViewBoard).mockImplementation(canView as any);
  vi.mocked(getLink).mockResolvedValue(link as any);
  vi.mocked(getPixel).mockResolvedValue(pixel as any);
  vi.mocked(getBoard).mockResolvedValue(board as any);
});

for (const { label, handler, record } of [
  { label: 'link', handler: getLinkRoute, record: link },
  { label: 'pixel', handler: getPixelRoute, record: pixel },
  { label: 'board', handler: getBoardRoute, record: board },
]) {
  test(`${label} reads do not expose ownership metadata to share-only viewers`, async () => {
    const params = Promise.resolve({ linkId: entityId, pixelId: entityId, boardId: entityId });
    for (const auth of [
      { shareToken: { entityId } },
      { user: { id: 'unrelated-user' }, shareToken: { entityId } },
    ]) {
      vi.mocked(parseRequest).mockResolvedValue({ auth } as any);
      const response = await handler(new Request(`http://localhost/api/${label}s/${entityId}`), {
        params,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        Object.fromEntries(
          Object.entries(record).filter(([key]) => !Object.hasOwn(privateFields, key)),
        ),
      );
    }

    vi.mocked(parseRequest).mockResolvedValue({ auth: { user: { id: 'owner-1' } } } as any);
    const ownerResponse = await handler(new Request(`http://localhost/api/${label}s/${entityId}`), {
      params,
    });
    expect(ownerResponse.status).toBe(200);
    expect(await ownerResponse.json()).toEqual(expect.objectContaining(privateFields));
  });
}
