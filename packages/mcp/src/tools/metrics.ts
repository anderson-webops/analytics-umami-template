import { z } from 'zod';
import { dateRangeInput, parseDateRange, timezone } from '../lib/dates';
import { filtersSchema, toFilterParams } from '../lib/filters';
import { clamp, DEFAULT_METRIC_LIMIT, MAX_METRIC_LIMIT } from '../lib/limits';
import { defineTool } from '../lib/tool';

export const METRIC_TYPES = [
  'path',
  'entry',
  'exit',
  'title',
  'query',
  'hostname',
  'referrer',
  'domain',
  'channel',
  'event',
  'tag',
  'browser',
  'os',
  'device',
  'screen',
  'language',
  'country',
  'region',
  'city',
  'distinctId',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
] as const;

const METRIC_DESCRIPTIONS: Record<(typeof METRIC_TYPES)[number], string> = {
  path: 'top pages (URL paths) by pageviews',
  entry: 'entry pages (first page of a visit)',
  exit: 'exit pages (last page of a visit)',
  title: 'page titles',
  query: 'URL query strings',
  hostname: 'hostnames',
  referrer: 'referrer domains (traffic sources)',
  domain: 'referrer domains, same as referrer',
  channel: 'marketing channels (direct, organic search, social, referral, email, paid…)',
  event: 'custom event names by count',
  tag: 'tracker tags',
  browser: 'browsers',
  os: 'operating systems',
  device: 'device types (desktop, laptop, tablet, mobile)',
  screen: 'screen sizes',
  language: 'browser languages',
  country: 'countries (ISO codes)',
  region: 'regions',
  city: 'cities',
  distinctId: 'identified users (distinct IDs)',
  utmSource: 'UTM sources',
  utmMedium: 'UTM mediums',
  utmCampaign: 'UTM campaigns',
  utmContent: 'UTM content values',
  utmTerm: 'UTM terms',
};

const VISITOR_TYPES = new Set([
  'browser',
  'os',
  'device',
  'screen',
  'language',
  'country',
  'region',
  'city',
  'distinctId',
  'referrer',
  'domain',
  'channel',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
]);

interface MetricRow {
  x: string | null;
  y: number;
  metricProvenance?: unknown;
}

export const getWebsiteMetrics = defineTool({
  name: 'get_website_metrics',
  title: 'Get ranked website metrics',
  description:
    'Returns a ranked breakdown of website traffic for one dimension during a time range: ' +
    'top pages, referrers, channels, countries, browsers, devices, UTM campaigns, custom events, and more. ' +
    'Values count distinct recorded sessions for traffic dimensions, or website-backend authorized ' +
    'custom-event occurrences for event. The legacy measure field is only a display label; ' +
    'countUnit gives the actual count unit. ' +
    'Public traffic is unverified; custom event counts require website-backend authorization. ' +
    'Null provenance means the API did not provide a consistent label. ' +
    'Available types: ' +
    METRIC_TYPES.map(type => `${type} (${METRIC_DESCRIPTIONS[type]})`).join('; ') +
    '. Requires a websiteId from list_websites.',
  inputSchema: z.object({
    websiteId: z.string().uuid().describe('Website ID from list_websites.'),
    ...dateRangeInput,
    type: z.enum(METRIC_TYPES).describe('Dimension to rank.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_METRIC_LIMIT)
      .optional()
      .describe(
        `Maximum rows to return (default ${DEFAULT_METRIC_LIMIT}, max ${MAX_METRIC_LIMIT}).`,
      ),
    offset: z.number().int().nonnegative().optional().describe('Rows to skip, for paging.'),
    search: z.string().optional().describe('Only include values containing this text.'),
    timezone: timezone.optional(),
    filters: filtersSchema.optional(),
  }),
  async handler(input, { client }) {
    const range = parseDateRange(input);
    const limit = clamp(input.limit, DEFAULT_METRIC_LIMIT, MAX_METRIC_LIMIT);
    const rows = (await client.getWebsiteMetrics({
      websiteId: input.websiteId,
      startAt: range.startAt,
      endAt: range.endAt,
      type: input.type,
      limit,
      offset: input.offset,
      search: input.search,
      timezone: input.timezone,
      ...toFilterParams(input.filters),
    })) as MetricRow[];
    const expectedProvenance =
      input.type === 'event' ? 'backend_authorized_event_counts' : 'unverified_public_observations';
    const firstProvenance = Array.isArray(rows) ? rows[0]?.metricProvenance : undefined;
    const metricProvenance =
      Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every(row => row.metricProvenance === firstProvenance) &&
      firstProvenance === expectedProvenance
        ? firstProvenance
        : null;

    return {
      websiteId: input.websiteId,
      type: input.type,
      measure: VISITOR_TYPES.has(input.type) ? 'visitors' : 'views',
      countUnit: input.type === 'event' ? 'event_occurrences' : 'recorded_sessions',
      metricProvenance,
      range: {
        startAt: new Date(range.startAt).toISOString(),
        endAt: new Date(range.endAt).toISOString(),
      },
      limit,
      offset: input.offset ?? 0,
      data: (Array.isArray(rows) ? rows : []).map(row => ({
        name: row.x ?? '(none)',
        value: Number(row.y ?? 0),
      })),
    };
  },
});
