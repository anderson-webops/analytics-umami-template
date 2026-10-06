import { beforeEach, expect, test, vi } from 'vitest';
import { EVENT_COLUMNS, SESSION_COLUMNS } from '@/lib/constants';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { fieldsParam } from '@/lib/schema';
import { canViewShareSection, getMetricShareSections, SHARE_SECTIONS } from '@/lib/share';
import { canViewSharedWebsiteFilters, canViewWebsiteSection } from '@/permissions';
import {
  getChannelExpandedMetrics,
  getChannelMetrics,
  getEventExpandedMetrics,
  getEventMetrics,
  getPageviewExpandedMetrics,
  getPageviewMetrics,
  getSessionExpandedMetrics,
  getSessionMetrics,
  getValues,
} from '@/queries/sql';
import { GET as getValuesRoute } from '../values/route';
import { GET as getExpandedMetrics } from './expanded/route';
import { GET as getMetrics } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewSharedWebsiteFilters: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));
vi.mock('@/queries/sql', () => ({
  getChannelMetrics: vi.fn(),
  getChannelExpandedMetrics: vi.fn(),
  getEventMetrics: vi.fn(),
  getEventExpandedMetrics: vi.fn(),
  getPageviewMetrics: vi.fn(),
  getPageviewExpandedMetrics: vi.fn(),
  getSessionMetrics: vi.fn(),
  getSessionExpandedMetrics: vi.fn(),
  getValues: vi.fn(),
}));

const params = Promise.resolve({ websiteId: 'website-1' });
const metricTypes = [...new Set([...SESSION_COLUMNS, ...EVENT_COLUMNS, 'channel'])];
const queries = [
  getChannelMetrics,
  getChannelExpandedMetrics,
  getEventMetrics,
  getEventExpandedMetrics,
  getPageviewMetrics,
  getPageviewExpandedMetrics,
  getSessionMetrics,
  getSessionExpandedMetrics,
  getValues,
];

function shareAuth(section: (typeof SHARE_SECTIONS)[number], allowFilter = false) {
  return {
    shareToken: {
      websiteId: 'website-1',
      parameters: {
        ...Object.fromEntries(SHARE_SECTIONS.map(name => [name, false])),
        [section]: true,
        allowFilter,
      },
    },
  };
}

async function callRoute(
  handler: typeof getMetrics,
  type: string,
  auth: ReturnType<typeof shareAuth> | { user: { id: string } },
) {
  vi.mocked(parseRequest).mockResolvedValue({ auth, query: { type } });
  return handler(new Request(`http://localhost/api/websites/website-1/metrics?type=${type}`), {
    params,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getQueryFilters).mockResolvedValue({});
  vi.mocked(canViewWebsiteSection).mockImplementation(async (auth, _websiteId, sections) => {
    return !!auth?.user || canViewShareSection(auth?.shareToken?.parameters, sections);
  });
  vi.mocked(canViewSharedWebsiteFilters).mockImplementation(async auth => {
    return !!auth?.user || auth?.shareToken?.parameters?.allowFilter !== false;
  });
  for (const query of queries) {
    vi.mocked(query).mockResolvedValue([] as never);
  }
});

test('every metric type requires a section that actually exposes it', async () => {
  for (const type of metricTypes) {
    const allowedSections = getMetricShareSections(type);
    expect(allowedSections, type).not.toBeNull();

    for (const section of SHARE_SECTIONS) {
      const response = await callRoute(getMetrics, type, shareAuth(section));
      expect(response.status, `${type} from ${section}`).toBe(
        allowedSections?.includes(section) ? 200 : 401,
      );
    }
  }
});

test('unmapped metric types fail closed without querying data', async () => {
  for (const handler of [getMetrics, getExpandedMetrics]) {
    expect((await callRoute(handler, 'newDimension', shareAuth('overview'))).status).toBe(401);
  }
  expect(getQueryFilters).not.toHaveBeenCalled();
});

test('compare-only shares cannot read overview-only expanded dimensions', async () => {
  for (const type of ['fullPath', 'entry', 'exit', 'domain', 'title', 'query']) {
    vi.clearAllMocks();
    const response = await callRoute(getExpandedMetrics, type, shareAuth('compare'));
    expect(response.status, type).toBe(401);
    expect(getQueryFilters).not.toHaveBeenCalled();
    expect(getPageviewExpandedMetrics).not.toHaveBeenCalled();
  }
});

test('expanded metrics require their mapped overview or compare section', async () => {
  for (const type of metricTypes) {
    const allowedSections = getMetricShareSections(type)?.filter(
      section => section === 'overview' || section === 'compare',
    );
    expect(allowedSections, type).not.toBeNull();

    for (const section of SHARE_SECTIONS) {
      const response = await callRoute(getExpandedMetrics, type, shareAuth(section));
      expect(response.status, `${type} from ${section}`).toBe(
        allowedSections?.some(allowedSection => allowedSection === section) ? 200 : 401,
      );
    }
  }
});

test('expanded metrics do not grant access to events-only or sessions-only shares', async () => {
  expect((await callRoute(getExpandedMetrics, 'event', shareAuth('events'))).status).toBe(401);
  expect((await callRoute(getExpandedMetrics, 'browser', shareAuth('sessions'))).status).toBe(401);
});

test('compare metrics stay within the compare selector', async () => {
  for (const type of ['fullPath', 'entry', 'exit', 'domain', 'title', 'query']) {
    expect((await callRoute(getMetrics, type, shareAuth('compare'))).status, type).toBe(401);
  }

  for (const type of ['path', 'event', 'distinctId', 'utmSource']) {
    expect((await callRoute(getMetrics, type, shareAuth('compare'))).status, type).toBe(200);
  }
});

test('filter-disabled shares cannot enumerate values outside report selectors', async () => {
  for (const section of SHARE_SECTIONS) {
    for (const type of ['distinctId', 'path', 'event']) {
      const response = await callRoute(getValuesRoute, type, shareAuth(section));
      const allowed = ['journeys', 'attribution'].includes(section) && type !== 'distinctId';
      expect(response.status, `${type} from ${section}`).toBe(allowed ? 200 : 401);
    }
  }
});

test('saved segment and cohort names are not values route types', () => {
  expect(fieldsParam.safeParse('segment').success).toBe(false);
  expect(fieldsParam.safeParse('cohort').success).toBe(false);
});

test('explicit share filtering and independent membership preserve values access', async () => {
  expect((await callRoute(getValuesRoute, 'distinctId', shareAuth('events', true))).status).toBe(
    200,
  );
  expect((await callRoute(getValuesRoute, 'distinctId', { user: { id: 'owner-1' } })).status).toBe(
    200,
  );
  expect((await callRoute(getMetrics, 'distinctId', { user: { id: 'owner-1' } })).status).toBe(200);
  expect(
    (await callRoute(getExpandedMetrics, 'distinctId', { user: { id: 'owner-1' } })).status,
  ).toBe(200);
  expect((await callRoute(getValuesRoute, 'distinctId', shareAuth('realtime', true))).status).toBe(
    401,
  );
});
