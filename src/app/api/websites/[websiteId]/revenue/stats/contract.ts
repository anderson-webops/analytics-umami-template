import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, jsonResponse, unauthorizedResponse } from '@/openapi/schemas';
import { revenueStatsQuerySchema } from './schema';

const statsSchema = z.object({
  sum: z.union([z.number(), z.string(), z.null()]),
  count: z.number(),
  average: z.number(),
  unique_count: z.number(),
  arpu: z.null(),
});

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/websites/{websiteId}/revenue/stats',
    audience: 'public',
    auth: 'bearer-or-share',
    operation: {
      operationId: 'getWebsiteRevenueStats',
      summary: 'Get unverified historical revenue claim totals',
      description:
        'Returns unverified historical event claims and a comparison period. Event and session counts are not verified orders or users; ARPU is unavailable.',
      tags: ['Websites'],
      requestParams: {
        path: z.object({ websiteId: z.uuid() }),
        query: revenueStatsQuerySchema,
      },
      responses: {
        '200': jsonResponse(
          statsSchema.extend({
            comparison: statsSchema,
            revenueProvenance: z.literal('unverified_historical_event_claims'),
          }),
        ),
        '400': badRequestResponse,
        '401': unauthorizedResponse,
      },
    },
  }),
] as const;
