import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, jsonResponse, unauthorizedResponse } from '@/openapi/schemas';
import { websiteIdPathSchema } from '../../../response-schema';
import { expandedMetricRowsSchema, metricsQuerySchema } from '../../analytics-schema';

const getWebsiteExpandedMetricsOperation = defineOperation({
  method: 'get',
  path: '/api/websites/{websiteId}/metrics/expanded',
  audience: 'public',
  auth: 'bearer-or-share',
  operation: {
    operationId: 'getWebsiteExpandedMetrics',
    summary: 'Get detailed website metrics',
    description:
      'Returns ranked traffic or event metrics for a dimension. Each row and the X-Metric-Provenance response header label counted-value provenance. Public traffic is unverified; event counts require website-backend authorization, while filters may still include unverified traffic. Visitor counts represent sessions, not verified people.',
    tags: ['Websites'],
    requestParams: {
      path: websiteIdPathSchema,
      query: metricsQuerySchema,
    },
    responses: {
      '200': jsonResponse(expandedMetricRowsSchema, 'Detailed ranked rows.'),
      '400': badRequestResponse,
      '401': unauthorizedResponse,
    },
  },
});

export const operations = [getWebsiteExpandedMetricsOperation] as const;
