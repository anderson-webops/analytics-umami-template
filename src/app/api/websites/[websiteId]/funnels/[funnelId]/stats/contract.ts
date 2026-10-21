import { z } from 'zod';
import { savedStatsQuerySchema } from '@/lib/analytics-schema';
import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, notFoundResponse, unauthorizedResponse } from '@/openapi/schemas';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/websites/{websiteId}/funnels/{funnelId}/stats',
    audience: 'public',
    auth: 'bearer-or-share',
    operation: {
      operationId: 'getWebsiteSavedFunnelStats',
      summary: 'Get website saved funnel stats',
      tags: ['Websites'],
      requestParams: {
        path: z.object({ websiteId: z.uuid(), funnelId: z.uuid() }),
        query: savedStatsQuerySchema,
      },
      responses: {
        '200': {
          description: 'The operation completed successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    visitors: {
                      type: 'number',
                      description:
                        'Distinct recorded session IDs at this step, not verified people.',
                    },
                    previous: {
                      type: 'number',
                    },
                    dropped: {
                      type: 'number',
                    },
                    dropoff: {
                      type: 'number',
                    },
                    remaining: {
                      type: 'number',
                    },
                    countUnit: {
                      type: 'string',
                      enum: ['sessions'],
                    },
                    stepProvenance: {
                      type: 'string',
                      enum: ['unverified_pageview', 'backend_authorized_event'],
                    },
                    stepSequenceProvenance: {
                      type: 'string',
                      enum: [
                        'includes_unverified_pageview_steps',
                        'backend_authorized_event_steps_only',
                      ],
                      description:
                        'Provenance of funnel steps through this step; cohort and other filters may still include unverified traffic.',
                    },
                    type: {
                      type: 'string',
                    },
                    value: {
                      type: 'string',
                    },
                    filters: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          property: {
                            type: 'string',
                          },
                          operator: {
                            type: 'string',
                          },
                          value: {
                            type: 'string',
                          },
                        },
                        required: ['property', 'operator', 'value'],
                      },
                    },
                  },
                  required: [
                    'visitors',
                    'previous',
                    'dropped',
                    'dropoff',
                    'remaining',
                    'countUnit',
                    'stepProvenance',
                    'stepSequenceProvenance',
                    'type',
                    'value',
                  ],
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
