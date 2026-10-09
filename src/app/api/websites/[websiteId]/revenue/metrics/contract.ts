import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, unauthorizedResponse } from '@/openapi/schemas';
import { revenueMetricsQuerySchema } from './schema';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/websites/{websiteId}/revenue/metrics',
    audience: 'public',
    auth: 'bearer-or-share',
    operation: {
      operationId: 'getWebsiteRevenueMetrics',
      summary: 'Get website revenue by dimension',
      description:
        'Returns revenue grouped by the requested dimension, such as country or referrer, for the selected currency and date range.',
      tags: ['Websites'],
      requestParams: { path: z.object({ websiteId: z.uuid() }), query: revenueMetricsQuerySchema },
      responses: {
        '200': {
          description: 'The operation completed successfully.',
          content: {
            'application/json': {
              schema: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', description: 'Display name of the resource.' },
                        value: { type: 'number' },
                      },
                      required: ['name', 'value'],
                    },
                  },
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', description: 'Display name of the resource.' },
                        value: { type: 'number' },
                        country: { type: 'string', description: 'Country code of the visitor.' },
                      },
                      required: ['name', 'value', 'country'],
                    },
                  },
                ],
              },
            },
          },
        },
        '400': badRequestResponse,
        '401': unauthorizedResponse,
      },
    },
  }),
] as const;
