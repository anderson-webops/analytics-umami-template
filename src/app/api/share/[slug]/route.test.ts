import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getBoardEntityIds } from '@/lib/boards';
import { ENTITY_TYPE } from '@/lib/constants';
import { createToken } from '@/lib/jwt';
import { getBoard, getShareByCode } from '@/queries/prisma';
import { GET } from './route';

const mocks = vi.hoisted(() => ({
  websites: vi.fn(),
  pixels: vi.fn(),
  links: vi.fn(),
  primaryOwner: vi.fn(),
  replicaOwner: vi.fn(),
  cacheGet: vi.fn(),
  redisEnabled: false,
}));

vi.mock('@/lib/boards', () => ({ getBoardEntityIds: vi.fn() }));
vi.mock('@/lib/crypto', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/crypto')>()),
  secret: () => 'unit-share-test-secret-00000000000000000000',
}));
vi.mock('@/lib/jwt', () => ({ createToken: vi.fn() }));
vi.mock('@/lib/redis', () => ({
  default: {
    get enabled() {
      return mocks.redisEnabled;
    },
    client: { get: mocks.cacheGet },
  },
}));
vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({
        website: { findMany: mocks.websites },
        pixel: { findMany: mocks.pixels },
        link: { findMany: mocks.links },
        teamUser: { findFirst: mocks.primaryOwner },
      }),
      teamUser: { findFirst: mocks.replicaOwner },
    },
  },
}));
vi.mock('@/queries/prisma', () => ({
  getBoard: vi.fn(),
  getLink: vi.fn(),
  getPixel: vi.fn(),
  getShareByCode: vi.fn(),
  getWebsite: vi.fn(),
}));

const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const teamId = uuid(90);
const ownerId = uuid(91);
const slug = 'syntheticPublicShare';
const source = (index: number, userId: string | null, sourceTeamId: string | null) => ({
  id: uuid(index),
  userId,
  teamId: sourceTeamId,
  deletedAt: null,
});
const entities = [
  source(1, null, teamId),
  source(2, ownerId, null),
  source(3, null, uuid(92)),
  source(4, null, teamId),
  source(5, ownerId, null),
  source(6, null, teamId),
  source(7, ownerId, null),
];
const request = () =>
  GET(new Request(`http://localhost/api/share/${slug}`), {
    params: Promise.resolve({ slug }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DISABLE_PUBLIC_SHARES', '0');
  mocks.redisEnabled = false;
  mocks.primaryOwner.mockResolvedValue(null);
  mocks.cacheGet.mockResolvedValue(null);
  const lookup = async ({ where }: { where: { id: { in: string[] } } }) =>
    entities.filter(entity => where.id.in.includes(entity.id));
  mocks.websites.mockImplementation(lookup);
  mocks.pixels.mockImplementation(lookup);
  mocks.links.mockImplementation(lookup);
  vi.mocked(createToken).mockReturnValue('synthetic-share-token');
  vi.mocked(getShareByCode).mockResolvedValue({
    id: uuid(100),
    shareType: ENTITY_TYPE.board,
    entityId: uuid(101),
    parameters: {},
  } as never);
  vi.mocked(getBoard).mockResolvedValue({
    id: uuid(101),
    type: 'dashboard',
    parameters: {},
    teamId,
    userId: null,
  } as never);
  vi.mocked(getBoardEntityIds).mockReturnValue({
    websiteIds: [uuid(1), uuid(2), uuid(3)],
    pixelIds: [uuid(4), uuid(5)],
    linkIds: [uuid(6), uuid(7)],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('a team board share mints only current team-owned entity ids with private caching', async () => {
  const response = await request();

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ token: 'synthetic-share-token' });
  expect(vi.mocked(createToken).mock.calls[0][0]).toMatchObject({
    websiteIds: [uuid(1)],
    pixelIds: [uuid(4)],
    linkIds: [uuid(6)],
  });
});

test('a personal board excludes foreign entities even when its owner could otherwise view them', async () => {
  vi.mocked(getBoard).mockResolvedValue({
    id: uuid(101),
    type: 'dashboard',
    parameters: {},
    teamId: null,
    userId: ownerId,
  } as never);

  expect((await request()).status).toBe(200);
  expect(vi.mocked(createToken).mock.calls[0][0]).toMatchObject({
    websiteIds: [uuid(2)],
    pixelIds: [uuid(5)],
    linkIds: [uuid(7)],
  });
});

test('white-label ownership reads the current primary team owner', async () => {
  mocks.redisEnabled = true;
  mocks.primaryOwner.mockResolvedValue({ userId: ownerId });
  mocks.replicaOwner.mockResolvedValue({ userId: 'stale-owner' });
  const whiteLabel = { displayName: 'Example', domainName: 'https://brand.example', logoUrl: '' };
  mocks.cacheGet.mockResolvedValue(whiteLabel);

  const response = await request();

  expect(await response.json()).toHaveProperty('whiteLabel', whiteLabel);
  expect(mocks.cacheGet).toHaveBeenCalledWith(`white-label:${ownerId}`);
  expect(mocks.replicaOwner).not.toHaveBeenCalled();
});

test.each([
  { displayName: 'Example', domainName: 'javascript:alert(1)', logoUrl: '' },
  {
    displayName: 'Example',
    domainName: 'https://brand.example',
    logoUrl: 'http://brand.example/logo.svg',
  },
])('unvalidated branding remains outside the capability response', async whiteLabel => {
  mocks.redisEnabled = true;
  mocks.primaryOwner.mockResolvedValue({ userId: ownerId });
  mocks.cacheGet.mockResolvedValue(whiteLabel);

  const response = await request();

  expect(response.status).toBe(200);
  expect(await response.json()).not.toHaveProperty('whiteLabel');
});

test('optional branding-cache failure preserves an independently authorized share', async () => {
  mocks.redisEnabled = true;
  mocks.primaryOwner.mockResolvedValue({ userId: ownerId });
  mocks.cacheGet.mockRejectedValue(new Error('Synthetic cache outage'));

  const response = await request();

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ token: 'synthetic-share-token' });
});

test('a missing current board cannot mint a share capability', async () => {
  vi.mocked(getBoard).mockResolvedValue(null);

  expect((await request()).status).toBe(404);
  expect(createToken).not.toHaveBeenCalled();
});

test('disabled public shares remain unavailable before reading capability metadata', async () => {
  vi.stubEnv('DISABLE_PUBLIC_SHARES', '1');

  expect((await request()).status).toBe(404);
  expect(getShareByCode).not.toHaveBeenCalled();
  expect(createToken).not.toHaveBeenCalled();
});
