import { beforeEach, expect, test, vi } from 'vitest';
import { assertEntityIdAvailable } from './authorization';

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));

const entityId = '11111111-1111-4111-8111-111111111111';
const stores = {
  website: { findUnique: vi.fn() },
  link: { findUnique: vi.fn() },
  pixel: { findUnique: vi.fn() },
  board: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
};

beforeEach(() => {
  for (const store of Object.values(stores)) store.findUnique.mockReset().mockResolvedValue(null);
});

test.each(['website', 'link', 'pixel', 'board', 'user'] as const)(
  'the mutation transaction rejects an id reserved by a %s',
  async store => {
    stores[store].findUnique.mockResolvedValue({ id: entityId });

    await expect(assertEntityIdAvailable(stores as never, entityId)).rejects.toThrow(
      'ENTITY_ID_CONFLICT',
    );
    expect(stores[store].findUnique).toHaveBeenCalledWith({
      where: { id: entityId },
      select: { id: true },
    });
  },
);

test('deleted user ids stay reserved without relying on a nontransactional lookup', async () => {
  stores.user.findUnique.mockResolvedValue({ id: entityId, deletedAt: new Date() });

  await expect(assertEntityIdAvailable(stores as never, entityId)).rejects.toThrow(
    'ENTITY_ID_CONFLICT',
  );
  expect(stores.user.findUnique).toHaveBeenCalledExactlyOnceWith({
    where: { id: entityId },
    select: { id: true },
  });
});

test('the owning personal dashboard can claim its reserved user id', async () => {
  stores.user.findUnique.mockResolvedValue({ id: entityId });

  await expect(
    assertEntityIdAvailable(stores as never, entityId, { personalDashboardUserId: entityId }),
  ).resolves.toBeUndefined();
});

test('a dashboard reservation for another user cannot claim the id', async () => {
  stores.user.findUnique.mockResolvedValue({ id: entityId });

  await expect(
    assertEntityIdAvailable(stores as never, entityId, { personalDashboardUserId: 'other-user' }),
  ).rejects.toThrow('ENTITY_ID_CONFLICT');
});

test.each(['website', 'link', 'pixel', 'board'] as const)(
  'a personal dashboard reservation cannot shadow an existing %s',
  async store => {
    stores[store].findUnique.mockResolvedValue({ id: entityId });
    stores.user.findUnique.mockResolvedValue({ id: entityId });

    await expect(
      assertEntityIdAvailable(stores as never, entityId, { personalDashboardUserId: entityId }),
    ).rejects.toThrow('ENTITY_ID_CONFLICT');
  },
);

test('a new id is checked against every namespace in the supplied transaction', async () => {
  await expect(assertEntityIdAvailable(stores as never, entityId)).resolves.toBeUndefined();

  for (const store of Object.values(stores)) {
    expect(store.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: entityId },
      select: { id: true },
    });
  }
});
