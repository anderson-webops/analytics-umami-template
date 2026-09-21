import { z } from 'zod';
import {
  domainParam,
  pagingParams,
  routeSlugParam,
  searchParams,
  sortingParams,
} from '@/lib/schema';

export const replayConfigInputSchema = z
  .object({
    replayEnabled: z.boolean().optional(),
    heatmapEnabled: z.boolean().optional(),
    sampleRate: z.number().min(0).max(1).optional(),
    heatmapSampleRate: z.number().min(0).max(1).optional(),
    maskLevel: z.enum(['strict', 'moderate']).optional(),
    maxDuration: z.number().int().min(60_000).max(3_600_000).optional(),
    blockSelector: z.string().max(1_000).optional(),
  })
  .strict()
  .meta({ id: 'ReplayConfigInput' });

export const listWebsitesQuerySchema = z
  .object({
    ...pagingParams,
    ...searchParams,
    ...sortingParams,
    includeTeams: z.string().optional().meta({
      description: 'When present, include websites accessible through owned or managed teams.',
    }),
  })
  .meta({ id: 'ListWebsitesQuery' });

export const createWebsiteRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    domain: domainParam,
    shareId: routeSlugParam.nullable().optional(),
    teamId: z.uuid().nullable().optional(),
    id: z.uuid().nullable().optional(),
  })
  .strict()
  .meta({ id: 'CreateWebsiteRequest' });

export const updateWebsiteRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    domain: domainParam.optional(),
    shareId: routeSlugParam.nullable().optional(),
    replayConfig: replayConfigInputSchema.nullable().optional(),
  })
  .strict()
  .meta({ id: 'UpdateWebsiteRequest' });
