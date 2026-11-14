import { beforeEach, expect, test, vi } from 'vitest';
import { BOARD_TYPES } from '@/lib/boards';
import type { Auth } from '@/lib/types';
import { createBoard } from './board';

const mocks = vi.hoisted(() => ({ owner: vi.fn(), references: vi.fn(), transaction: vi.fn() }));

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('./authorization', async importOriginal => ({
  ...(await importOriginal<typeof import('./authorization')>()),
  assertActorCanCreateOwnedEntity: mocks.owner,
  assertActorCanAccessEntities: mocks.references,
  runSerializable: mocks.transaction,
}));
vi.mock('./collection', () => ({ lockCollectionSources: vi.fn() }));

const actorId = '11111111-1111-4111-8111-111111111111';
const boardId = '22222222-2222-4222-8222-222222222222';
const auth = { authType: 'session', user: { id: actorId, role: 'user' } } as Auth;
const stores = {
  website: { findUnique: vi.fn() },
  link: { findUnique: vi.fn() },
  pixel: { findUnique: vi.fn() },
  board: { findUnique: vi.fn(), create: vi.fn() },
  user: { findUnique: vi.fn() },
};
const personalDashboard = {
  id: actorId,
  userId: actorId,
  name: 'Personal dashboard',
  description: '',
  type: BOARD_TYPES.dashboard,
  parameters: {},
};

beforeEach(() => {
  mocks.owner.mockReset().mockResolvedValue(undefined);
  mocks.references.mockReset().mockResolvedValue(undefined);
  mocks.transaction.mockReset().mockImplementation(operation => operation(stores));
  for (const store of Object.values(stores)) store.findUnique.mockReset().mockResolvedValue(null);
  stores.user.findUnique.mockImplementation(async ({ where }) =>
    where.id === actorId ? { id: actorId } : null,
  );
  stores.board.create.mockReset().mockImplementation(async ({ data }) => data);
});

test('the authenticated personal dashboard keeps its reserved user id and owner guard', async () => {
  await expect(
    createBoard(personalDashboard, actorId, { auth, isPersonalDashboard: true }),
  ).resolves.toEqual(personalDashboard);

  expect(mocks.owner).toHaveBeenCalledWith(
    stores,
    actorId,
    { userId: actorId },
    {
      auth,
      requireGlobalCreatePermission: false,
    },
  );
  expect(stores.board.create).toHaveBeenCalledExactlyOnceWith({ data: personalDashboard });
});

test('an ordinary board cannot claim a reserved user id', async () => {
  await expect(createBoard(personalDashboard, actorId, { auth })).rejects.toThrow(
    'ENTITY_ID_CONFLICT',
  );
  expect(stores.board.create).not.toHaveBeenCalled();
});

test.each([{ id: boardId }, { userId: boardId }, { teamId: boardId }, { type: BOARD_TYPES.mixed }])(
  'a mismatched personal-dashboard identity is rejected before checking references',
  async override => {
    await expect(
      createBoard({ ...personalDashboard, ...override }, actorId, {
        auth,
        isPersonalDashboard: true,
      }),
    ).rejects.toThrow('ENTITY_ACTOR_NOT_AUTHORIZED');
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.references).not.toHaveBeenCalled();
    expect(stores.board.create).not.toHaveBeenCalled();
  },
);

test.each(['website', 'link', 'pixel', 'board'] as const)(
  'the personal dashboard preserves the existing %s namespace',
  async store => {
    stores[store].findUnique.mockResolvedValue({ id: actorId });

    await expect(
      createBoard(personalDashboard, actorId, { auth, isPersonalDashboard: true }),
    ).rejects.toThrow('ENTITY_ID_CONFLICT');
    expect(stores.board.create).not.toHaveBeenCalled();
  },
);

test('a new ordinary board still requires normal global create permission', async () => {
  const data = { ...personalDashboard, id: boardId, type: BOARD_TYPES.mixed };

  await expect(createBoard(data, actorId, { auth })).resolves.toEqual(data);
  expect(mocks.owner).toHaveBeenCalledWith(
    stores,
    actorId,
    { userId: actorId },
    {
      auth,
      requireGlobalCreatePermission: true,
    },
  );
});

test('changed owner authentication prevents all dashboard creation writes', async () => {
  mocks.owner.mockRejectedValue(new Error('ENTITY_ACTOR_NOT_AUTHORIZED'));

  await expect(
    createBoard(personalDashboard, actorId, { auth, isPersonalDashboard: true }),
  ).rejects.toThrow('ENTITY_ACTOR_NOT_AUTHORIZED');
  expect(stores.user.findUnique).not.toHaveBeenCalled();
  expect(stores.board.create).not.toHaveBeenCalled();
});
