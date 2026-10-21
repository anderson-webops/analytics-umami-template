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
      summary: 'Get unverified historical revenue claims by dimension',
      description:
        'Returns unverified historical event claims grouped by the requested dimension, such as country or referrer. Values do not prove completed orders or payments.',
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
                        revenueProvenance: {
                          type: 'string',
                          enum: ['unverified_historical_event_claims'],
                        },
                      },
                      required: ['name', 'value', 'revenueProvenance'],
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
                        revenueProvenance: {
                          type: 'string',
                          enum: ['unverified_historical_event_claims'],
                        },
                      },
                      required: ['name', 'value', 'country', 'revenueProvenance'],
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
