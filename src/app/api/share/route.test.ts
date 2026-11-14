import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { parseRequest } from '@/lib/request';
import { canUpdateWebsite } from '@/permissions';
import { createShare, getWebsite } from '@/queries/prisma';
import { POST } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canShareBoardEntities: vi.fn(),
  canUpdateBoard: vi.fn(),
  canUpdateLink: vi.fn(),
  canUpdatePixel: vi.fn(),
  canUpdateWebsite: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  createShare: vi.fn(),
  getBoard: vi.fn(),
  getLink: vi.fn(),
  getPixel: vi.fn(),
  getWebsite: vi.fn(),
}));

const entityId = '11111111-1111-4111-8111-111111111111';
const auth = { authType: 'session', user: { id: 'manager', role: 'user' } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DISABLE_PUBLIC_SHARES', '0');
  vi.mocked(parseRequest).mockResolvedValue({
    auth,
    body: { entityId, shareType: ENTITY_TYPE.website, name: 'Public', parameters: {} },
  });
  vi.mocked(canUpdateWebsite).mockResolvedValue(true);
  vi.mocked(getWebsite).mockResolvedValue({ id: entityId } as never);
  vi.mocked(createShare).mockImplementation(async data => data as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('a unique-slug collision is reported as a conflict without accepting a caller-selected slug', async () => {
  vi.mocked(createShare).mockRejectedValueOnce(
    Object.assign(new Error('Synthetic collision'), { code: 'P2002' }),
  );

  const response = await POST(new Request('http://localhost/api/share', { method: 'POST' }));

  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('conflict');
});

test('unknown storage failures propagate without converting their private message into a response', async () => {
  vi.mocked(createShare).mockRejectedValueOnce(new Error('Synthetic storage failure'));

  await expect(POST(new Request('http://localhost/api/share', { method: 'POST' }))).rejects.toThrow(
    'Synthetic storage failure',
  );
});

test('share creation carries its actor and auth to the guarded mutation and returns a noncacheable capability', async () => {
  const response = await POST(new Request('http://localhost/api/share', { method: 'POST' }));

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(createShare).toHaveBeenCalledWith(
    expect.objectContaining({ entityId, shareType: ENTITY_TYPE.website }),
    'manager',
    auth,
  );
  const result = await response.json();
  expect(result.slug).toEqual(expect.any(String));
  expect(result.slug).toMatch(/^[A-Za-z0-9_-]{24}$/);
});

test('a permission change at the mutation boundary remains unauthorized', async () => {
  vi.mocked(createShare).mockRejectedValueOnce(new Error('SHARE_ACTOR_NOT_AUTHORIZED'));

  expect((await POST(new Request('http://localhost/api/share', { method: 'POST' }))).status).toBe(
    401,
  );
});
