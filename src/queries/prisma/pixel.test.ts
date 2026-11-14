import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Auth } from '@/lib/types';
import { deletePixel as deleteResource, updatePixel as updateResource } from './pixel';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  auth: vi.fn(),
  cleanup: vi.fn(),
  invalidate: vi.fn(),
  redisEnabled: true,
}));
vi.mock('@/lib/prisma', () => ({ default: { transaction: mocks.transaction } }));
vi.mock('@/lib/redis', () => ({
  default: {
    get enabled() {
      return mocks.redisEnabled;
    },
    client: { del: mocks.invalidate },
  },
}));
vi.mock('@/queries/sql/deleteCollectionSources', () => ({
  deleteClickhouseCollectionSources: mocks.cleanup,
}));
vi.mock('./authorization', async importOriginal => ({
  ...(await importOriginal<typeof import('./authorization')>()),
  assertCurrentActorAuth: mocks.auth,
}));

const resourceName = 'pixel';
const actor = '11111111-1111-4111-8111-111111111111';
const resourceId = '22222222-2222-4222-8222-222222222222';
const auth = { authType: 'session', user: { id: actor, role: 'user' } } as Auth;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.redisEnabled = true;
  const deletion = () => ({ deleteMany: vi.fn().mockResolvedValue({ count: 0 }) });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findFirst: vi.fn().mockResolvedValue({ role: 'user' }) },
    [resourceName]: {
      findFirst: vi.fn().mockResolvedValue({ id: resourceId, userId: actor, teamId: null }),
      findUnique: mocks.findUnique,
      update: mocks.update,
      delete: mocks.remove,
    },
    revenue: deletion(),
    eventData: deletion(),
    sessionData: deletion(),
    websiteEvent: deletion(),
    session: deletion(),
    share: deletion(),
  };
  mocks.transaction.mockImplementation(async operation => operation(tx));
  mocks.findUnique.mockResolvedValue({ id: resourceId, slug: 'old' });
  mocks.update.mockResolvedValue({ id: resourceId, slug: 'new' });
  mocks.remove.mockResolvedValue({ id: resourceId, slug: 'old' });
});

describe('pixel cache invalidation', () => {
  test('updates invalidate both old and new slugs after authorized serializable writes', async () => {
    await updateResource(resourceId, { slug: 'new' }, actor, auth);
    expect(mocks.invalidate).toHaveBeenCalledWith('pixel:old');
    expect(mocks.invalidate).toHaveBeenCalledWith('pixel:new');
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
    expect(mocks.transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'Serializable' });
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Object), actor, auth);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });
  test('an unchanged slug is invalidated once', async () => {
    mocks.findUnique.mockResolvedValue({ id: resourceId, slug: 'same' });
    mocks.update.mockResolvedValue({ id: resourceId, slug: 'same' });
    await updateResource(resourceId, {}, actor, auth);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('pixel:same');
  });
  test('deletion invalidates the prior slug after guarded collection cleanup', async () => {
    await deleteResource(resourceId, actor, auth);
    expect(mocks.cleanup).toHaveBeenCalledWith([resourceId]);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('pixel:old');
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });
  test('disabled Redis preserves authorization and avoids cache writes', async () => {
    mocks.redisEnabled = false;
    await updateResource(resourceId, {}, actor, auth);
    await deleteResource(resourceId, actor, auth);
    expect(mocks.auth).toHaveBeenCalledTimes(2);
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  test('rejected authentication prevents source and cache writes', async () => {
    mocks.auth.mockRejectedValue(new Error('ENTITY_ACTOR_NOT_AUTHORIZED'));
    await expect(updateResource(resourceId, {}, actor, auth)).rejects.toThrow(
      'ENTITY_ACTOR_NOT_AUTHORIZED',
    );
    await expect(deleteResource(resourceId, actor, auth)).rejects.toThrow(
      'ENTITY_ACTOR_NOT_AUTHORIZED',
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  test('failed writes preserve cached routes', async () => {
    mocks.update.mockRejectedValue(new Error('Synthetic write failure'));
    await expect(updateResource(resourceId, {}, actor, auth)).rejects.toThrow(
      'Synthetic write failure',
    );
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  test('failed collection cleanup prevents deletion and cache invalidation', async () => {
    mocks.cleanup.mockRejectedValue(new Error('Synthetic cleanup failure'));
    await expect(deleteResource(resourceId, actor, auth)).rejects.toThrow(
      'Synthetic cleanup failure',
    );
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
