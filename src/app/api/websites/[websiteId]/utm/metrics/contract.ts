import { z } from 'zod';
import { utmMetricsQuerySchema } from '@/lib/analytics-schema';
import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, notFoundResponse, unauthorizedResponse } from '@/openapi/schemas';

export const operations = [
  defineOperation({
    method: 'get',
    path: '/api/websites/{websiteId}/utm/metrics',
    audience: 'public',
    auth: 'bearer-or-share',
    operation: {
      operationId: 'getWebsiteUtmMetrics',
      summary: 'Get website utm metrics',
      tags: ['Websites'],
      requestParams: { path: z.object({ websiteId: z.uuid() }), query: utmMetricsQuerySchema },
      responses: {
        '200': {
          description:
            'Caller-reported UTM values and unverified public view counts. Each row and the X-Metric-Provenance response header declare the counted-value provenance.',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    utm: {
                      type: 'string',
                    },
                    views: {
                      type: 'number',
                    },
                    metricProvenance: {
                      type: 'string',
                      enum: ['unverified_public_observations'],
                    },
                  },
                  required: ['utm', 'views', 'metricProvenance'],
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
