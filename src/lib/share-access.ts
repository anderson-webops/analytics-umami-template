import 'server-only';
import type { Board, Link, Pixel, Share, Website } from '@/generated/prisma/client';
import { getBoardEntityIds } from '@/lib/boards';
import { ENTITY_TYPE } from '@/lib/constants';
import { getBoard, getLink, getPixel, getWebsite } from '@/queries/prisma';
import type { BoardParameters } from './types';

type BoardEntityIds = ReturnType<typeof getBoardEntityIds>;

export type ShareEntity = Website | Link | Pixel | Board;

function isOwnedByBoard(
  entity: Website | Link | Pixel | null,
  board: Pick<Board, 'userId' | 'teamId'>,
) {
  if (!entity || entity.deletedAt) {
    return false;
  }

  return board.teamId
    ? entity.teamId === board.teamId
    : !!board.userId && entity.userId === board.userId;
}

async function filterEntityIds(
  ids: string[],
  isAllowed: (id: string) => Promise<boolean>,
): Promise<string[]> {
  const results = await Promise.all(
    ids.map(async id => {
      try {
        return (await isAllowed(id)) ? id : null;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((id): id is string => !!id);
}

async function filterBoardEntityIds(
  board: Pick<Board, 'userId' | 'teamId'>,
  ids: BoardEntityIds,
): Promise<BoardEntityIds> {
  return {
    websiteIds: await filterEntityIds(ids.websiteIds, async id =>
      isOwnedByBoard(await getWebsite(id), board),
    ),
    pixelIds: await filterEntityIds(ids.pixelIds, async id =>
      isOwnedByBoard(await getPixel(id), board),
    ),
    linkIds: await filterEntityIds(ids.linkIds, async id =>
      isOwnedByBoard(await getLink(id), board),
    ),
  };
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
