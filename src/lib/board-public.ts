import { z } from 'zod';
import type { Board } from '@/generated/prisma/client';
import { getBoardEntity, type getBoardEntityIds } from '@/lib/boards';
import type { BoardParameters } from '@/lib/types';

type BoardEntityIds = ReturnType<typeof getBoardEntityIds>;

const emptyProps = z.object({}).strip();
const metricName = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,31}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const limit = z.union([
  z.number().int().min(1).max(500),
  z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .refine(value => Number(value) <= 500),
]);
const utmLimit = z.union([
  z.number().int().min(1).max(20),
  z.string().regex(/^(?:[1-9]|1[0-9]|20)$/),
]);
const publicPropSchemas: Record<string, z.ZodType> = {
  Goal: z.object({ reportId: z.uuid().optional() }).strip(),
  Funnel: z.object({ reportId: z.uuid().optional() }).strip(),
  UTM: z
    .object({
      param: z
        .enum(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'])
        .optional(),
      limit: utmLimit.optional(),
    })
    .strip(),
  RevenueMetricsBar: z.object({ currency: currency.optional() }).strip(),
  RevenueChart: z.object({ currency: currency.optional() }).strip(),
  RevenueMetricsTable: z
    .object({
      type: z.enum(['referrer', 'channel', 'country', 'region']).optional(),
      currency: currency.optional(),
    })
    .strip(),
  MetricsTable: z
    .object({
      type: metricName.optional(),
      limit: limit.optional(),
      params: z
        .object({ type: metricName.optional(), limit: limit.optional() })
        .strict()
        .optional(),
      showMore: z.boolean().optional(),
      filterLink: z.boolean().optional(),
    })
    .strip(),
  EventsChart: z.object({ limit: limit.optional() }).strip(),
  TextBlock: z.object({ text: z.string().optional() }).strip(),
};

const publicComponentParam = z
  .object({
    type: z.string().trim().min(1).max(100),
    entityType: z.enum(['website', 'pixel', 'link']).optional(),
    entityId: z.uuid().optional(),
    websiteId: z.uuid().optional(),
    title: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    props: z.unknown().optional(),
  })
  .strip();
const publicColumnParam = z
  .object({
    id: z.uuid(),
    component: publicComponentParam.nullable().optional(),
    size: z.number().finite().min(0).max(100).optional().catch(undefined),
  })
  .strip();
const publicRowParam = z
  .object({
    id: z.uuid(),
    columns: z.array(publicColumnParam).max(4),
    size: z.number().finite().min(0).max(100).optional().catch(undefined),
  })
  .strip();
const publicBoardParametersParam = z
  .object({
    websiteId: z.uuid().optional(),
    pixelId: z.uuid().optional(),
    linkId: z.uuid().optional(),
    rows: z.array(publicRowParam).max(50).optional(),
  })
  .strip();

export function filterSharedBoardParameters(
  board: Pick<Board, 'type' | 'parameters'>,
  allowedIds: Partial<BoardEntityIds>,
): BoardParameters {
  const parsedParameters = publicBoardParametersParam.safeParse(board.parameters);

  if (!parsedParameters.success) {
    return {};
  }

  const parameters = parsedParameters.data as BoardParameters;
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
            columns: row.columns.flatMap(column => {
              const component = column.component;

              if (
                !canExpose(boardEntity.entityType, boardEntity.entityId) ||
                !canExpose(component?.entityType, component?.entityId) ||
                !canExpose('website', component?.websiteId) ||
                !canExpose(component?.props?.entityType, component?.props?.entityId) ||
                !canExpose('website', component?.props?.websiteId) ||
                !canExpose('pixel', component?.props?.pixelId) ||
                !canExpose('link', component?.props?.linkId)
              ) {
                return [];
              }

              const props =
                component?.props === undefined
                  ? null
                  : (Object.hasOwn(publicPropSchemas, component.type)
                      ? publicPropSchemas[component.type]
                      : emptyProps
                    ).safeParse(component.props);

              if (props && !props.success) {
                return [];
              }

              return [
                {
                  id: column.id,
                  ...(column.size !== undefined ? { size: column.size } : {}),
                  ...(component
                    ? {
                        component: {
                          type: component.type,
                          ...(component.entityType ? { entityType: component.entityType } : {}),
                          ...(component.entityId ? { entityId: component.entityId } : {}),
                          ...(component.websiteId ? { websiteId: component.websiteId } : {}),
                          ...(component.title !== undefined ? { title: component.title } : {}),
                          ...(component.description !== undefined
                            ? { description: component.description }
                            : {}),
                          ...(props?.success ? { props: props.data } : {}),
                        },
                      }
                    : {}),
                },
              ];
            }),
          })),
        }
      : {}),
  };
}
