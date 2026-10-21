import { defineOperation } from '@/openapi/operation';
import { badRequestResponse, jsonResponse, unauthorizedResponse } from '@/openapi/schemas';
import { websiteIdPathSchema } from '../../response-schema';
import { metricRowsSchema, metricsQuerySchema } from '../analytics-schema';

const getWebsiteMetricsOperation = defineOperation({
  method: 'get',
  path: '/api/websites/{websiteId}/metrics',
  audience: 'public',
  auth: 'bearer-or-share',
  operation: {
    operationId: 'getWebsiteMetrics',
    summary: 'Get ranked metrics for a dimension',
    description:
      'Returns the top values for one dimension (`type`), such as pages, referrers, countries, browsers, UTM parameters or events, ordered by count. Each row and the X-Metric-Provenance response header identify whether the counted values are unverified public observations or backend-authorized events. Filters may still include unverified traffic; visitor values count sessions, not verified people.',
    tags: ['Websites'],
    requestParams: {
      path: websiteIdPathSchema,
      query: metricsQuerySchema,
    },
    responses: {
      '200': jsonResponse(metricRowsSchema, 'Ranked rows.'),
      '400': badRequestResponse,
      '401': unauthorizedResponse,
    },
  },
});

export const operations = [getWebsiteMetricsOperation] as const;
