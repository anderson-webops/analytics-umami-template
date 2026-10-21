import { defineOperation } from '@/openapi/operation';
import { jsonResponse, unauthorizedResponse } from '@/openapi/schemas';
import { websiteIdPathSchema } from '../../response-schema';
import { activeVisitorsSchema } from '../analytics-schema';

const getWebsiteActiveOperation = defineOperation({
  method: 'get',
  path: '/api/websites/{websiteId}/active',
  audience: 'public',
  auth: 'bearer-or-share',
  operation: {
    operationId: 'getWebsiteActive',
    summary: 'Get current active sessions',
    description:
      'Returns distinct session IDs active in the last few minutes. Public pageviews are unverified; this is not a count of verified people.',
    tags: ['Websites'],
    requestParams: {
      path: websiteIdPathSchema,
    },
    responses: {
      '200': jsonResponse(activeVisitorsSchema, 'Active session count and provenance.'),
      '401': unauthorizedResponse,
    },
  },
});

export const operations = [getWebsiteActiveOperation] as const;
