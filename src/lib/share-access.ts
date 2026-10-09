import 'server-only';
import { z } from 'zod';
import type { Board, Link, Pixel, Share, Website } from '@/generated/prisma/client';
import { getBoardEntityIds } from '@/lib/boards';
import { ENTITY_TYPE } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import { getBoard, getLink, getPixel, getWebsite } from '@/queries/prisma';
import type { BoardParameters } from './types';

type BoardEntityIds = ReturnType<typeof getBoardEntityIds>;
type BoardOwnedEntity = Pick<Website, 'id' | 'userId' | 'teamId' | 'deletedAt'>;

const websiteIdSchema = z.uuid();

export type ShareEntity = Website | Link | Pixel | Board;

function isOwnedByBoard(entity: BoardOwnedEntity | null, board: Pick<Board, 'userId' | 'teamId'>) {
  if (!entity || entity.deletedAt) {
    return false;
  }

  return board.teamId
    ? entity.teamId === board.teamId
    : !!board.userId && entity.userId === board.userId;
}

async function filterEntityIds(
  ids: string[],
  board: Pick<Board, 'userId' | 'teamId'>,
  isValid: (id: string) => boolean,
  read: (ids: string[]) => Promise<BoardOwnedEntity[]>,
): Promise<string[]> {
  const validIds = ids.filter(isValid);

  if (!validIds.length) {
    return [];
  }

  try {
    const entities = await read(validIds);
    const allowedIds = new Set(
      entities.filter(entity => isOwnedByBoard(entity, board)).map(entity => entity.id),
    );

    return ids.filter(id => allowedIds.has(id));
  } catch {
    return [];
  }
}

async function filterBoardEntityIds(
  board: Pick<Board, 'userId' | 'teamId'>,
  ids: BoardEntityIds,
): Promise<BoardEntityIds> {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const [websiteIds, pixelIds, linkIds] = await Promise.all([
    filterEntityIds(
      ids.websiteIds,
      board,
      id => websiteIdSchema.safeParse(id).success,
      validIds =>
        client.website.findMany({
          where: { id: { in: validIds }, deletedAt: null },
          select: { id: true, userId: true, teamId: true, deletedAt: true },
        }),
    ),
    filterEntityIds(ids.pixelIds, board, isUuid, validIds =>
      client.pixel.findMany({
        where: { id: { in: validIds }, deletedAt: null },
        select: { id: true, userId: true, teamId: true, deletedAt: true },
      }),
    ),
    filterEntityIds(ids.linkIds, board, isUuid, validIds =>
      client.link.findMany({
        where: { id: { in: validIds }, deletedAt: null },
        select: { id: true, userId: true, teamId: true, deletedAt: true },
      }),
    ),
  ]);

  return { websiteIds, pixelIds, linkIds };
}

export async function resolveShareAccess(
  share: Pick<Share, 'id' | 'entityId' | 'shareType' | 'parameters'>,
): Promise<{ data: Record<string, any>; entity: ShareEntity } | null> {
  const data: Record<string, any> = {
    shareId: share.id,
    shareType: share.shareType,
    parameters: share.parameters || {},
  };

  if (share.shareType === ENTITY_TYPE.board) {
    const board = await getBoard(share.entityId);

    if (!board) {
      return null;
    }

    const ids = getBoardEntityIds({
      type: board.type,
      parameters: board.parameters as BoardParameters,
    });
    const authorizedIds = await filterBoardEntityIds(board, ids);

    return {
      entity: board,
      data: {
        ...data,
        boardId: share.entityId,
        websiteIds: authorizedIds.websiteIds,
        pixelIds: authorizedIds.pixelIds,
        linkIds: authorizedIds.linkIds,
      },
    };
  }

  if (share.shareType === ENTITY_TYPE.website) {
    const website = await getWebsite(share.entityId);

    return website && !website.deletedAt
      ? { entity: website, data: { ...data, websiteId: share.entityId } }
      : null;
  }

  if (share.shareType === ENTITY_TYPE.pixel) {
    const pixel = await getPixel(share.entityId);

    return pixel && !pixel.deletedAt
      ? {
          entity: pixel,
          data: {
            ...data,
            websiteId: share.entityId,
            pixelId: share.entityId,
          },
        }
      : null;
  }

  if (share.shareType === ENTITY_TYPE.link) {
    const link = await getLink(share.entityId);

    return link && !link.deletedAt
      ? {
          entity: link,
          data: {
            ...data,
            websiteId: share.entityId,
            linkId: share.entityId,
          },
        }
      : null;
  }

  return null;
}
