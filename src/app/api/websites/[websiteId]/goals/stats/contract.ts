import { z } from 'zod';
import { goalQuerySchema } from '@/lib/analytics-schema';
import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, notFoundResponse, unauthorizedResponse } from '@/openapi/schemas';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/websites/{websiteId}/goals/stats',
    audience: 'public',
    auth: 'bearer-or-share',
    operation: {
      operationId: 'getWebsiteGoalStats',
      summary: 'Get website goal stats',
      tags: ['Websites'],
      requestParams: { path: z.object({ websiteId: z.uuid() }), query: goalQuerySchema },
      responses: {
        '200': {
          description: 'The operation completed successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  num: {
                    type: 'number',
                  },
                  total: {
                    type: 'number',
                  },
                  numeratorProvenance: {
                    type: 'string',
                    enum: ['unverified_pageview', 'backend_authorized_event'],
                    description:
                      'Pageview goals are observations; custom-event goals are website-backend authorized.',
                  },
                  denominatorProvenance: {
                    type: 'string',
                    enum: ['may_include_unverified_traffic'],
                    description: 'The session denominator can include unverified public traffic.',
                  },
                },
                required: ['num', 'total', 'numeratorProvenance', 'denominatorProvenance'],
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
