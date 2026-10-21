import { z } from 'zod';
import { defineTool } from '../lib/tool';

export const getRealtime = defineTool({
  name: 'get_realtime',
  title: 'Get current active sessions',
  description:
    'Returns distinct session IDs active on a website in the last few minutes, not verified people. ' +
    'Public pageviews may be unverified; null provenance means the API did not provide a recognized label. ' +
    'Requires a websiteId from list_websites.',
  inputSchema: z.object({
    websiteId: z.string().uuid().describe('Website ID from list_websites.'),
  }),
  annotations: { idempotentHint: false },
  async handler(input, { client }) {
    const result = await client.getWebsiteActive({ websiteId: input.websiteId });

    return {
      websiteId: input.websiteId,
      activeVisitors:
        Number.isSafeInteger(result?.visitors) && result.visitors >= 0 ? result.visitors : null,
      trafficProvenance:
        result?.trafficProvenance === 'may_include_unverified_public_observations'
          ? result.trafficProvenance
          : null,
      asOf: new Date().toISOString(),
    };
  },
});
