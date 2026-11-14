import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { parseRequest } from '@/lib/request';
import { canDeleteShareEntity, canUpdateShareEntity } from '@/permissions';
import { deleteShare, getShare, updateShare } from '@/queries/prisma';
import { DELETE, GET, POST } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({ canDeleteShareEntity: vi.fn(), canUpdateShareEntity: vi.fn() }));
vi.mock('@/queries/prisma', () => ({
  deleteShare: vi.fn(),
  getShare: vi.fn(),
  updateShare: vi.fn(),
}));

const shareId = '22222222-2222-4222-8222-222222222222';
const entityId = '11111111-1111-4111-8111-111111111111';
const auth = { authType: 'session', user: { id: 'manager', role: 'user' } };
const share = {
  id: shareId,
  entityId,
  shareType: ENTITY_TYPE.website,
  slug: 'syntheticPublicSlug',
  name: 'Public',
  parameters: {},
};
const context = { params: Promise.resolve({ shareId }) };
const request = (method: string) =>
  new Request(`http://localhost/api/share/id/${shareId}`, { method });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DISABLE_PUBLIC_SHARES', '0');
  vi.mocked(parseRequest).mockResolvedValue({
    auth,
    body: { name: 'Updated', slug: share.slug, parameters: {} },
  });
  vi.mocked(canUpdateShareEntity).mockResolvedValue(true);
  vi.mocked(canDeleteShareEntity).mockResolvedValue(true);
  vi.mocked(getShare).mockResolvedValue(share as never);
  vi.mocked(updateShare).mockResolvedValue(share as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('GET and DELETE return 404 for an unknown share before any mutation', async () => {
  vi.mocked(getShare).mockResolvedValue(null);

  expect((await GET(request('GET'), context)).status).toBe(404);
  expect((await DELETE(request('DELETE'), context)).status).toBe(404);
  expect(deleteShare).not.toHaveBeenCalled();
});

test('bearer-slug management reads require update permission and stay noncacheable', async () => {
  const response = await GET(request('GET'), context);

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(canUpdateShareEntity).toHaveBeenCalledWith(auth, share.shareType, entityId);

  vi.mocked(canUpdateShareEntity).mockResolvedValue(false);
  expect((await GET(request('GET'), context)).status).toBe(401);
});

test('caller-selected replacement slugs stay rejected before the mutation', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth,
    body: { name: 'Updated', slug: 'caller-selected', parameters: {} },
  });

  expect((await POST(request('POST'), context)).status).toBe(400);
  expect(updateShare).not.toHaveBeenCalled();
});

test('a unique-slug collision at the guarded mutation returns conflict', async () => {
  vi.mocked(updateShare).mockRejectedValueOnce(
    Object.assign(new Error('Synthetic collision'), { code: 'P2002' }),
  );

  expect((await POST(request('POST'), context)).status).toBe(409);
});

test('unknown storage failures propagate without exposing a database error response', async () => {
  vi.mocked(updateShare).mockRejectedValueOnce(new Error('Synthetic storage failure'));

  await expect(POST(request('POST'), context)).rejects.toThrow('Synthetic storage failure');
});

test('updates preserve actor/auth and noncacheable capability responses', async () => {
  const response = await POST(request('POST'), context);

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(updateShare).toHaveBeenCalledWith(
    shareId,
    expect.objectContaining({ slug: share.slug }),
    'manager',
    auth,
  );
});

test('owner deletion remains available when public publication is disabled', async () => {
  vi.stubEnv('DISABLE_PUBLIC_SHARES', '1');
  try {
    expect((await DELETE(request('DELETE'), context)).status).toBe(200);
    expect(deleteShare).toHaveBeenCalledWith(shareId, 'manager', auth);
  } finally {
    vi.unstubAllEnvs();
  }
});
