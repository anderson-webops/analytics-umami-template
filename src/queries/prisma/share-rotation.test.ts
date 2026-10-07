import { beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import { assertActorCanMutateEntity, runSerializable } from './authorization';
import { getShare, updateShare } from './share';

const database = vi.hoisted(() => ({
  share: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({ share: { findUnique: database.share.findUnique } }),
    },
  },
}));

vi.mock('./authorization', () => ({
  assertActorCanMutateEntity: vi.fn(),
  assertActorCanAccessEntities: vi.fn(),
  runSerializable: vi.fn(async operation => operation(database)),
}));

const originalId = '26a3b489-e0ee-4ba8-9b4d-f47b3efcd699';
const entityId = '71636934-8138-421f-81f3-7d99f03a5acd';
let currentShare: {
  id: string;
  entityId: string;
  shareType: number;
  slug: string;
  name: string;
  parameters: Record<string, boolean>;
};

beforeEach(() => {
  vi.clearAllMocks();
  currentShare = {
    id: originalId,
    entityId,
    shareType: ENTITY_TYPE.website,
    slug: 'original',
    name: 'Example',
    parameters: { events: true },
  };
  database.share.findUnique.mockImplementation(async ({ where }) =>
    where.id === currentShare.id || where.slug === currentShare.slug ? currentShare : null,
  );
  database.share.update.mockImplementation(async ({ data }) => {
    currentShare = { ...currentShare, ...data };
    return currentShare;
  });
});

test('rotating a slug revokes the old share ID even after rotating back', async () => {
  const firstRotation = await updateShare(
    originalId,
    { name: 'Example', slug: 'replacement', parameters: { events: true } },
    'manager',
  );
  const replacementId = firstRotation.id;

  expect(isUuid(replacementId)).toBe(true);
  expect(replacementId).not.toBe(originalId);
  expect(await getShare(originalId)).toBeNull();
  expect(await getShare(replacementId)).toEqual(firstRotation);

  const secondRotation = await updateShare(
    replacementId,
    { name: 'Example', slug: 'original', parameters: { events: true } },
    'manager',
  );

  expect(secondRotation.id).not.toBe(replacementId);
  expect(secondRotation.id).not.toBe(originalId);
  expect(await getShare(originalId)).toBeNull();
  expect(await getShare(replacementId)).toBeNull();
  expect(await getShare(secondRotation.id)).toEqual(secondRotation);
  expect(runSerializable).toHaveBeenCalledTimes(2);
  expect(assertActorCanMutateEntity).toHaveBeenCalledTimes(2);
});

test('editing a share without changing its slug retains its ID', async () => {
  const result = await updateShare(
    originalId,
    { name: 'Renamed', slug: 'original', parameters: { events: false } },
    'manager',
  );

  expect(result.id).toBe(originalId);
  expect(result.parameters).toEqual({ events: false });
  expect(database.share.update).toHaveBeenCalledWith({
    where: { id: originalId },
    data: { name: 'Renamed', slug: 'original', parameters: { events: false } },
  });
});

test('revoked update permission prevents slug and ID changes', async () => {
  vi.mocked(assertActorCanMutateEntity).mockRejectedValueOnce(
    new Error('ENTITY_ACTOR_NOT_AUTHORIZED'),
  );

  await expect(
    updateShare(
      originalId,
      { name: 'Example', slug: 'replacement', parameters: { events: true } },
      'manager',
    ),
  ).rejects.toThrow('SHARE_ACTOR_NOT_AUTHORIZED');
  expect(database.share.update).not.toHaveBeenCalled();
  expect(currentShare.id).toBe(originalId);
});
