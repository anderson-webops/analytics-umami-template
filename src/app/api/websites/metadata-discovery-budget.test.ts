import { beforeEach, expect, test, vi } from 'vitest';
import { parsePropertyFilters } from '@/lib/params';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import {
  getEventDataFields,
  getEventDataProperties,
  getEventDataValues,
  getSessionDataProperties,
  getSessionDataValues,
} from '@/queries/sql';
import { DiscoveryRangeTooBroadError } from '@/queries/sql/events/discoveryError';
import { getEventDataEvents } from '@/queries/sql/events/getEventDataEvents';
import { GET as getEventNames } from './[websiteId]/event-data/events/route';
import { GET as getEventFields } from './[websiteId]/event-data/fields/route';
import { GET as getEventProperties } from './[websiteId]/event-data/properties/route';
import { GET as getEventValues } from './[websiteId]/event-data/values/route';
import { GET as getSessionProperties } from './[websiteId]/session-data/properties/route';
import { GET as getSessionValues } from './[websiteId]/session-data/values/route';

vi.mock('@/lib/params', () => ({ parsePropertyFilters: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/clickhouse', () => ({
  default: {},
  isClickHouseDiscoveryLimitError: vi.fn(),
}));
vi.mock('@/lib/request', () => ({ getQueryFilters: vi.fn(), parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql', () => ({
  getEventDataFields: vi.fn(),
  getEventDataProperties: vi.fn(),
  getEventDataValues: vi.fn(),
  getSessionDataProperties: vi.fn(),
  getSessionDataValues: vi.fn(),
}));
vi.mock('@/queries/sql/events/getEventDataEvents', () => ({ getEventDataEvents: vi.fn() }));

const routes = [
  ['event fields', getEventFields, vi.mocked(getEventDataFields)],
  ['event names', getEventNames, vi.mocked(getEventDataEvents)],
  ['event properties', getEventProperties, vi.mocked(getEventDataProperties)],
  ['event values', getEventValues, vi.mocked(getEventDataValues)],
  ['session properties', getSessionProperties, vi.mocked(getSessionDataProperties)],
  ['session values', getSessionValues, vi.mocked(getSessionDataValues)],
] as const;

beforeEach(() => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: {},
    query: { startAt: 1, endAt: 2, propertyName: 'category' },
    error: undefined,
  } as any);
  vi.mocked(getQueryFilters).mockResolvedValue({} as any);
  vi.mocked(parsePropertyFilters).mockReturnValue([]);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  for (const [, , query] of routes) {
    query.mockReset();
  }
});

test.each(routes)('%s returns a safe explicit narrow-range response', async (_, route, query) => {
  query.mockRejectedValue(new DiscoveryRangeTooBroadError());

  const response = await route(new Request('http://localhost/api/websites/website-1/metadata'), {
    params: Promise.resolve({ websiteId: 'website-1' }),
  });

  expect(response.status).toBe(400);
  expect(await response.text()).toContain('Narrow the date range or filters');
});

test.each(routes)('%s does not hide unrelated query failures', async (_, route, query) => {
  query.mockRejectedValue(new Error('database unavailable'));

  await expect(
    route(new Request('http://localhost/api/websites/website-1/metadata'), {
      params: Promise.resolve({ websiteId: 'website-1' }),
    }),
  ).rejects.toThrow('database unavailable');
});
