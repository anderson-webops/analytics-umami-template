import type { Prisma } from '@/generated/prisma/client';
import { BOARD_TYPES, getBoardEntityIds } from '@/lib/boards';
import { ENTITY_TYPE, PERMISSIONS } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import { sanitizeSortFilters } from '@/lib/sort';
import type { BoardParameters, QueryFilters } from '@/lib/types';
import {
  assertActorCanAccessEntities,
  assertActorCanCreateOwnedEntity,
  assertActorCanMutateEntity,
  assertEntityIdAvailable,
  runSerializable,
} from './authorization';
import { lockCollectionSources } from './collection';

const BOARD_SORT_FIELDS = ['name', 'description', 'type', 'createdAt'] as const;

function getBoardEntityReferences(type: string, parameters: BoardParameters) {
  const { websiteIds, linkIds, pixelIds } = getBoardEntityIds({ type, parameters });

  return [
    ...websiteIds.map(entityId => ({ entityType: 'website' as const, entityId })),
    ...linkIds.map(entityId => ({ entityType: 'link' as const, entityId })),
    ...pixelIds.map(entityId => ({ entityType: 'pixel' as const, entityId })),
  ];
}

export async function findBoard(criteria: Prisma.BoardFindUniqueArgs) {
  return prisma.client.board.findUnique(criteria);
}

export async function getBoard(boardId: string) {
  if (!isUuid(boardId)) {
    return null;
  }

  return findBoard({
    where: {
      id: boardId,
    },
  });
}

export async function getBoards(criteria: Prisma.BoardFindManyArgs, filters: QueryFilters = {}) {
  const sortFilters = sanitizeSortFilters(filters, BOARD_SORT_FIELDS);
  const { search } = sortFilters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where: Prisma.BoardWhereInput = {
    ...criteria.where,
    ...getSearchParameters(search, [{ name: 'contains' }, { description: 'contains' }]),
  };

  return pagedQuery('board', { ...criteria, where }, sortFilters);
}

export async function getUserBoards(userId: string, filters?: QueryFilters) {
  return getBoards(
    {
      where: {
        userId,
        type: {
          not: BOARD_TYPES.dashboard,
        },
      },
    },
    filters,
  );
}

export async function getTeamBoards(teamId: string, filters?: QueryFilters) {
  return getBoards(
    {
      where: {
        teamId,
        type: {
          not: BOARD_TYPES.dashboard,
        },
      },
    },
    filters,
  );
}

export async function createBoard(
  data: Prisma.BoardUncheckedCreateInput,
  actorUserId: string,
  options: { isPersonalDashboard?: boolean } = {},
) {
  return runSerializable(async transaction => {
    if (data.teamId) {
      await assertActorCanCreateOwnedEntity(transaction, actorUserId, {
        teamId: data.teamId,
      });
    } else if (data.userId) {
      await assertActorCanCreateOwnedEntity(
        transaction,
        actorUserId,
        {
          userId: data.userId,
        },
        {
          requireGlobalCreatePermission: !options.isPersonalDashboard,
        },
      );
    } else {
      throw new Error('ENTITY_OWNER_NOT_FOUND');
    }

    await assertEntityIdAvailable(transaction, data.id);

    const references = getBoardEntityReferences(data.type, data.parameters as BoardParameters);
    await lockCollectionSources(
      transaction,
      references.map(reference => reference.entityId),
    );
    await assertActorCanAccessEntities(transaction, actorUserId, references);

    return transaction.board.create({ data });
  });
}

export async function updateBoard(
  boardId: string,
  data: Prisma.BoardUncheckedUpdateInput,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'board',
      boardId,
      PERMISSIONS.websiteUpdate,
    );

    const currentBoard = await transaction.board.findUnique({
      where: { id: boardId },
      select: {
        type: true,
        parameters: true,
      },
    });

    if (!currentBoard) {
      throw new Error('ENTITY_NOT_FOUND');
    }

    const nextType = typeof data.type === 'string' ? data.type : currentBoard.type;
    const nextParameters = (data.parameters ?? currentBoard.parameters) as BoardParameters;
    const references = getBoardEntityReferences(nextType, nextParameters);

    await lockCollectionSources(
      transaction,
      references.map(reference => reference.entityId),
    );
    await assertActorCanAccessEntities(transaction, actorUserId, references);

    return transaction.board.update({ where: { id: boardId }, data });
  });
}

export async function deleteBoard(boardId: string, actorUserId: string) {
  return runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'board',
      boardId,
      PERMISSIONS.websiteDelete,
    );

    await transaction.share.deleteMany({
      where: {
        entityId: boardId,
        shareType: ENTITY_TYPE.board,
      },
    });

    return transaction.board.delete({ where: { id: boardId } });
  });
}
