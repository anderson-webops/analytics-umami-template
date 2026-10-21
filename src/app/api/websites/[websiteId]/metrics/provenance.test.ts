import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import {
  getChannelExpandedMetrics,
  getChannelMetrics,
  getEventExpandedMetrics,
  getEventMetrics,
  getPageviewExpandedMetrics,
  getPageviewMetrics,
  getSessionExpandedMetrics,
  getSessionMetrics,
} from '@/queries/sql';
import { GET as getExpandedMetrics } from './expanded/route';
import { GET as getMetrics } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql', () => ({
  getChannelExpandedMetrics: vi.fn(),
  getChannelMetrics: vi.fn(),
  getEventExpandedMetrics: vi.fn(),
  getEventMetrics: vi.fn(),
  getPageviewExpandedMetrics: vi.fn(),
  getPageviewMetrics: vi.fn(),
  getSessionExpandedMetrics: vi.fn(),
  getSessionMetrics: vi.fn(),
}));

const websiteId = '00000000-0000-4000-8000-000000000001';
const queryFunctions = [
  getChannelExpandedMetrics,
  getChannelMetrics,
  getEventExpandedMetrics,
  getEventMetrics,
  getPageviewExpandedMetrics,
  getPageviewMetrics,
  getSessionExpandedMetrics,
  getSessionMetrics,
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getQueryFilters).mockResolvedValue({} as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
});

test.each([
  ['path', 'unverified_public_observations'],
  ['browser', 'unverified_public_observations'],
  ['channel', 'unverified_public_observations'],
  ['event', 'backend_authorized_event_counts'],
] as const)(
  '%s metrics expose numerator provenance in both response formats',
  async (type, expected) => {
    vi.mocked(parseRequest).mockResolvedValue({
      auth: { user: { id: 'viewer' } },
      query: { type },
    } as any);

    for (const [handler, expanded] of [
      [getMetrics, false],
      [getExpandedMetrics, true],
    ] as const) {
      const row = expanded
        ? { name: 'result', pageviews: 4, visitors: 3, visits: 3, bounces: 1, totaltime: 20 }
        : { x: 'result', y: 4 };
      for (const queryFunction of queryFunctions) {
        vi.mocked(queryFunction).mockResolvedValue([row] as never);
      }

      const response = await handler(
        new Request(`https://analytics.example/api/websites/${websiteId}/metrics`),
        { params: Promise.resolve({ websiteId }) },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Metric-Provenance')).toBe(expected);
      expect(await response.json()).toEqual([{ ...row, metricProvenance: expected }]);
    }
  },
);

test.each([getMetrics, getExpandedMetrics])(
  'empty metrics still declare provenance',
  async handler => {
    vi.mocked(parseRequest).mockResolvedValue({
      auth: { user: { id: 'viewer' } },
      query: { type: 'path' },
    } as any);
    vi.mocked(getPageviewMetrics).mockResolvedValue([]);
    vi.mocked(getPageviewExpandedMetrics).mockResolvedValue([]);

    const response = await handler(
      new Request(`https://analytics.example/api/websites/${websiteId}/metrics`),
      { params: Promise.resolve({ websiteId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Metric-Provenance')).toBe('unverified_public_observations');
    expect(await response.json()).toEqual([]);
  },
);
