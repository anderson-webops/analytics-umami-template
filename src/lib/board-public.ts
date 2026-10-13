import type { Board } from '@/generated/prisma/client';
import { getBoardEntity, type getBoardEntityIds } from '@/lib/boards';
import type { BoardParameters } from '@/lib/types';

type BoardEntityIds = ReturnType<typeof getBoardEntityIds>;

export function filterSharedBoardParameters(
  board: Pick<Board, 'type' | 'parameters'>,
  allowedIds: Partial<BoardEntityIds>,
): BoardParameters {
  const parameters = board.parameters as BoardParameters;
  const allowed = {
    website: new Set(allowedIds.websiteIds ?? []),
    pixel: new Set(allowedIds.pixelIds ?? []),
    link: new Set(allowedIds.linkIds ?? []),
  };
  const canExpose = (entityType: string | undefined, entityId: unknown) =>
    entityId === undefined ||
    (typeof entityId === 'string' &&
      (entityType === 'website' || entityType === 'pixel' || entityType === 'link') &&
      allowed[entityType].has(entityId));
  const boardEntity = getBoardEntity({ type: board.type, parameters });

  return {
    ...(canExpose('website', parameters.websiteId) && parameters.websiteId
      ? { websiteId: parameters.websiteId }
      : {}),
    ...(canExpose('pixel', parameters.pixelId) && parameters.pixelId
      ? { pixelId: parameters.pixelId }
      : {}),
    ...(canExpose('link', parameters.linkId) && parameters.linkId
      ? { linkId: parameters.linkId }
      : {}),
    ...(parameters.rows
      ? {
          rows: parameters.rows.map(row => ({
            id: row.id,
            size: row.size,
            columns: row.columns.filter(column => {
              const component = column.component;

              return (
                canExpose(boardEntity.entityType, boardEntity.entityId) &&
                canExpose(component?.entityType, component?.entityId) &&
                canExpose('website', component?.websiteId) &&
                canExpose(component?.props?.entityType, component?.props?.entityId) &&
                canExpose('website', component?.props?.websiteId) &&
                canExpose('pixel', component?.props?.pixelId) &&
                canExpose('link', component?.props?.linkId)
              );
            }),
          })),
        }
      : {}),
  };
}
