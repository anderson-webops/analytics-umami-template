import { z } from 'zod';
import { journeyQuerySchema } from '@/lib/analytics-schema';
import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, notFoundResponse, unauthorizedResponse } from '@/openapi/schemas';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/websites/{websiteId}/journeys',
    audience: 'public',
    auth: 'bearer-or-share',
    operation: {
      operationId: 'getWebsiteJourneys',
      summary: 'Get website journeys',
      tags: ['Websites'],
      requestParams: { path: z.object({ websiteId: z.uuid() }), query: journeyQuerySchema },
      responses: {
        '200': {
          description:
            'Journey paths may include unverified public pageviews alongside backend-authorized custom events. Counts represent visits, not verified people. Each row and the X-Traffic-Provenance response header declare this limitation.',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'string',
                      },
                    },
                    count: {
                      type: 'number',
                      description: 'Number of visits with this journey.',
                    },
                    trafficProvenance: {
                      type: 'string',
                      enum: ['may_include_unverified_public_observations'],
                    },
                  },
                  required: ['items', 'count', 'trafficProvenance'],
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
