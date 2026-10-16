import { beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE, PERMISSIONS } from '@/lib/constants';
import {
  assertActorCanAccessEntities,
  assertActorCanMutateEntity,
  runSerializable,
} from './authorization';
import { updateBoard } from './board';

const boardId = '508ad3c6-1993-41aa-a07c-44ff09a64686';
const websiteId = '7b2728e9-f4b2-4a2a-9827-697b24bbf78a';
const sessionAuth = {
  authType: 'session' as const,
  user: { id: 'board-editor', username: 'editor', role: 'user', isAdmin: false },
};
const apiKeyAuth = { ...sessionAuth, authType: 'api-key' as const };
const transaction = vi.hoisted(() => ({
  board: { findUnique: vi.fn(), update: vi.fn() },
  share: { findFirst: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('./authorization', () => ({
  assertActorCanAccessEntities: vi.fn(),
  assertActorCanCreateOwnedEntity: vi.fn(),
  assertActorCanMutateEntity: vi.fn(),
  assertCurrentActorAuth: vi.fn(),
  assertEntityIdAvailable: vi.fn(),
  runSerializable: vi.fn(async operation => operation(transaction)),
}));
vi.mock('./collection', () => ({ lockCollectionSources: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertActorCanAccessEntities).mockReset();
  transaction.board.findUnique.mockResolvedValue({ type: 'website', parameters: { websiteId } });
  transaction.board.update.mockResolvedValue({ id: boardId });
  transaction.share.findFirst.mockResolvedValue(null);
});

test('a shared board rejects references the editor can view but cannot share', async () => {
  transaction.share.findFirst.mockResolvedValue({ id: 'active-share' });
  vi.mocked(assertActorCanAccessEntities).mockImplementation(
    async (_client, _actor, _references, permission) => {
      if (permission === PERMISSIONS.websiteUpdate) {
        throw new Error('ENTITY_REFERENCE_NOT_AUTHORIZED');
      }
    },
  );

  await expect(
    updateBoard(boardId, { parameters: { websiteId } }, 'board-editor', sessionAuth),
  ).rejects.toThrow('ENTITY_REFERENCE_NOT_AUTHORIZED');
  expect(runSerializable).toHaveBeenCalledOnce();
  expect(assertActorCanMutateEntity).toHaveBeenCalledWith(
    transaction,
    'board-editor',
    'board',
    boardId,
    PERMISSIONS.websiteUpdate,
  );
  expect(transaction.share.findFirst).toHaveBeenCalledWith({
    where: { entityId: boardId, shareType: ENTITY_TYPE.board },
    select: { id: true },
  });
  expect(assertActorCanAccessEntities).toHaveBeenCalledWith(
    transaction,
    'board-editor',
    [{ entityType: 'website', entityId: websiteId }],
    PERMISSIONS.websiteUpdate,
  );
  expect(transaction.board.update).not.toHaveBeenCalled();
});

test('a shared board accepts references the editor is allowed to share', async () => {
  transaction.share.findFirst.mockResolvedValue({ id: 'active-share' });

  await expect(
    updateBoard(boardId, { type: 'website' }, 'board-editor', sessionAuth),
  ).resolves.toEqual({
    id: boardId,
  });
  expect(assertActorCanAccessEntities).toHaveBeenCalledWith(
    transaction,
    'board-editor',
    [{ entityType: 'website', entityId: websiteId }],
    PERMISSIONS.websiteUpdate,
  );
  expect(transaction.board.update).toHaveBeenCalledOnce();
});

test('an unshared board still accepts viewable references', async () => {
  await expect(
    updateBoard(boardId, { parameters: { websiteId } }, 'board-editor', sessionAuth),
  ).resolves.toEqual({ id: boardId });
  expect(assertActorCanAccessEntities).toHaveBeenCalledWith(
    transaction,
    'board-editor',
    [{ entityType: 'website', entityId: websiteId }],
    undefined,
  );
});

test('a metadata-only edit does not change a shared board reference grant', async () => {
  await expect(
    updateBoard(boardId, { name: 'Renamed' }, 'board-editor', sessionAuth),
  ).resolves.toEqual({
    id: boardId,
  });
  expect(transaction.share.findFirst).not.toHaveBeenCalled();
  expect(assertActorCanAccessEntities).toHaveBeenCalledWith(
    transaction,
    'board-editor',
    [{ entityType: 'website', entityId: websiteId }],
    undefined,
  );
});

test.each([
  { field: 'parameters', data: { parameters: { websiteId } } },
  { field: 'type', data: { type: 'website' } },
])('an API key cannot change $field on a shared board', async ({ data }) => {
  transaction.share.findFirst.mockResolvedValue({ id: 'active-share' });

  await expect(updateBoard(boardId, data, 'board-editor', apiKeyAuth)).rejects.toThrow(
    'SHARED_BOARD_REQUIRES_SESSION',
  );
  expect(runSerializable).toHaveBeenCalledOnce();
  expect(transaction.share.findFirst).toHaveBeenCalledOnce();
  expect(assertActorCanAccessEntities).not.toHaveBeenCalled();
  expect(transaction.board.update).not.toHaveBeenCalled();
});

test('an API key can edit an unshared board', async () => {
  await expect(
    updateBoard(boardId, { parameters: { websiteId } }, 'board-editor', apiKeyAuth),
  ).resolves.toEqual({ id: boardId });
  expect(transaction.board.update).toHaveBeenCalledOnce();
});

test('an API key can edit shared board metadata without changing its references', async () => {
  transaction.share.findFirst.mockResolvedValue({ id: 'active-share' });

  await expect(
    updateBoard(boardId, { name: 'Renamed' }, 'board-editor', apiKeyAuth),
  ).resolves.toEqual({
    id: boardId,
  });
  expect(transaction.share.findFirst).not.toHaveBeenCalled();
  expect(transaction.board.update).toHaveBeenCalledOnce();
});
