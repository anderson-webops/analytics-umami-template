import { z } from 'zod';
import { breakdownQuerySchema } from '@/lib/analytics-schema';
import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, notFoundResponse, unauthorizedResponse } from '@/openapi/schemas';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/websites/{websiteId}/breakdown',
    audience: 'public',
    auth: 'bearer-or-share',
    operation: {
      operationId: 'getWebsiteBreakdown',
      summary: 'Get website breakdown',
      tags: ['Websites'],
      requestParams: { path: z.object({ websiteId: z.uuid() }), query: breakdownQuerySchema },
      responses: {
        '200': {
          description:
            'Views and session denominators come from unverified public pageviews. Backend-authorized custom events can affect bounce classification. Each row and the X-Metric-Provenance response header declare the pageview provenance; visitor and visit counts represent session IDs, not verified people.',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    views: {
                      type: 'number',
                    },
                    visitors: {
                      type: 'number',
                    },
                    visits: {
                      type: 'number',
                    },
                    bounces: {
                      type: 'number',
                    },
                    totaltime: {
                      type: 'number',
                    },
                    metricProvenance: {
                      type: 'string',
                      enum: ['unverified_public_observations'],
                    },
                  },
                  required: [
                    'views',
                    'visitors',
                    'visits',
                    'bounces',
                    'totaltime',
                    'metricProvenance',
                  ],
                  additionalProperties: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'number',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        '400': badRequestResponse,
        '401': unauthorizedResponse,
        '404': notFoundResponse,
      },
    },
  }),
] as const;
