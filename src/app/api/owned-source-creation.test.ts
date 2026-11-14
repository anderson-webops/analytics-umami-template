import { beforeEach, expect, test, vi } from 'vitest';
import { POST as createLink } from './links/route';
import { POST as createPixel } from './pixels/route';
import { POST as createWebsite } from './websites/route';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  occupied: vi.fn(),
  permission: vi.fn(),
  website: vi.fn(),
  link: vi.fn(),
  pixel: vi.fn(),
}));

vi.mock('@/lib/request', () => ({ parseRequest: mocks.parse, getQueryFilters: vi.fn() }));
vi.mock('@/lib/entity', () => ({ isEntityIdInUse: mocks.occupied }));
vi.mock('@/lib/load', () => ({ fetchAccount: vi.fn(), fetchTeam: vi.fn() }));
vi.mock('@/permissions', () => ({
  canCreateWebsite: mocks.permission,
  canCreateTeamWebsite: mocks.permission,
  redactWebsiteListShareIds: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  createWebsite: mocks.website,
  createLink: mocks.link,
  createPixel: mocks.pixel,
  getUserLinks: vi.fn(),
  getUserPixels: vi.fn(),
}));
vi.mock('@/queries/prisma/website', () => ({
  getAllUserWebsitesIncludingTeamAccess: vi.fn(),
  getUserWebsites: vi.fn(),
}));

const actorId = '11111111-1111-4111-8111-111111111111';
const entityId = '22222222-2222-4222-8222-222222222222';
const auth = {
  authType: 'session',
  user: { id: actorId, role: 'admin', isAdmin: true },
  passwordFingerprint: 'synthetic-fingerprint',
  sessionGeneration: 0,
};
const routes = [
  { name: 'websites', handle: createWebsite, write: mocks.website },
  { name: 'links', handle: createLink, write: mocks.link },
  { name: 'pixels', handle: createPixel, write: mocks.pixel },
];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.parse.mockResolvedValue({
    auth,
    body: { id: entityId, name: 'Synthetic', url: 'https://example.com', slug: 'synthetic' },
  });
  mocks.occupied.mockResolvedValue(false);
  mocks.permission.mockResolvedValue(true);
});

test.each(routes)(
  '$name requires administrator authority before checking a custom id',
  async route => {
    mocks.parse.mockResolvedValue({
      auth: { ...auth, user: { ...auth.user, role: 'user', isAdmin: false } },
      body: { id: entityId, name: 'Synthetic', url: 'https://example.com', slug: 'synthetic' },
    });

    const response = await route.handle(
      new Request(`http://localhost/api/${route.name}`, { method: 'POST' }),
    );

    expect(response.status).toBe(401);
    expect(mocks.occupied).not.toHaveBeenCalled();
    expect(route.write).not.toHaveBeenCalled();
  },
);

test.each(routes)('$name retains the upstream early custom-id collision check', async route => {
  mocks.occupied.mockResolvedValue(true);

  const response = await route.handle(
    new Request(`http://localhost/api/${route.name}`, { method: 'POST' }),
  );

  expect(response.status).toBe(400);
  expect(mocks.occupied).toHaveBeenCalledExactlyOnceWith(entityId);
  expect(route.write).not.toHaveBeenCalled();
});

test.each(routes)(
  '$name still rejects a collision discovered by the guarded mutation',
  async route => {
    route.write.mockRejectedValueOnce(new Error('ENTITY_ID_CONFLICT'));

    const response = await route.handle(
      new Request(`http://localhost/api/${route.name}`, { method: 'POST' }),
    );

    expect(response.status).toBe(409);
    expect(route.write).toHaveBeenCalledWith(
      expect.objectContaining({ id: entityId }),
      actorId,
      expect.objectContaining({ auth, customEntityId: true }),
    );
  },
);

test.each(routes)(
  '$name preserves a changed-permission refusal after its preflight check',
  async route => {
    route.write.mockRejectedValueOnce(new Error('ENTITY_ACTOR_NOT_AUTHORIZED'));

    const response = await route.handle(
      new Request(`http://localhost/api/${route.name}`, { method: 'POST' }),
    );

    expect(response.status).toBe(401);
  },
);
