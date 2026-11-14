import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { MAX_SHARE_SESSION_ROWS } from '@/lib/share-query-budget';
import { GET as getEventById } from './event-data/[eventId]/route';
import { GET as getEventRows } from './event-data/route';
import { GET as getEventPivot } from './event-data-pivot/route';
import { GET as getRevenueRows } from './revenue/sessions/route';
import { GET as getSessionProperties } from './sessions/[sessionId]/properties/route';
import { GET as getValues } from './values/route';

const state = vi.hoisted(() => ({
  auth: {} as Record<string, any>,
  parseError: 0,
  parseRequest: vi.fn(),
  filters: vi.fn(),
  eventRows: vi.fn(),
  eventById: vi.fn(),
  pivot: vi.fn(),
  revenue: vi.fn(),
  values: vi.fn(),
  sessionProperties: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: state.parseRequest,
  getQueryFilters: state.filters,
}));
vi.mock('@/permissions', async () => import('@/permissions/share'));
vi.mock('@/permissions/website', () => ({
  canViewWebsite: async (auth: any, websiteId: string) =>
    auth.user?.id === 'owner' ||
    (auth.shareToken?.shareType === ENTITY_TYPE.website && auth.shareToken.websiteId === websiteId),
  canUpdateWebsite: vi.fn(),
  canDeleteWebsite: vi.fn(),
}));
vi.mock('@/permissions/board', () => ({
  canViewBoard: vi.fn(),
  canUpdateBoard: vi.fn(),
  canDeleteBoard: vi.fn(),
}));
vi.mock('@/permissions/link', () => ({
  canViewLink: vi.fn(),
  canUpdateLink: vi.fn(),
  canDeleteLink: vi.fn(),
}));
vi.mock('@/permissions/pixel', () => ({
  canViewPixel: vi.fn(),
  canUpdatePixel: vi.fn(),
  canDeletePixel: vi.fn(),
}));
vi.mock('@/queries/sql/events/getEventData', () => ({
  getEventData: state.eventRows,
  EventDataPageTooBroadError: class extends Error {},
}));
vi.mock('@/queries/sql/events/getEventDataById', () => ({ getEventDataById: state.eventById }));
vi.mock('@/queries/sql/events/getEventDataPivot', () => ({ getEventDataPivot: state.pivot }));
vi.mock('@/queries/sql/revenue/getRevenueSessions', () => ({ getRevenueSessions: state.revenue }));
vi.mock('@/queries/sql', () => ({
  getValues: state.values,
  getSessionData: state.sessionProperties,
}));
vi.mock('@/queries/sql/sessions/getVerifiedIdentityFilterSessions', () => ({
  getVerifiedIdentityFilterSessions: vi.fn(),
}));

const websiteId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const context = { params: Promise.resolve({ websiteId, eventId }) };
const endpoints = [
  ['event properties', getEventRows, state.eventRows, 'events'],
  ['single event', getEventById, state.eventById, 'events'],
  ['event pivot', getEventPivot, state.pivot, 'events'],
  ['revenue sessions', getRevenueRows, state.revenue, 'revenue'],
] as const;
const request = () =>
  new Request(
    `https://analytics.example/api/websites/${websiteId}/event-data?startAt=1793491200000&endAt=1793577600000&eventName=purchase&currency=USD&type=distinctId`,
  );
function share(
  shareType: (typeof ENTITY_TYPE)[keyof typeof ENTITY_TYPE] = ENTITY_TYPE.website,
  parameters: Record<string, boolean> = {},
) {
  return {
    shareToken: {
      shareId: crypto.randomUUID(),
      shareType,
      websiteId,
      websiteIds: [websiteId],
      scopedApiAccess: true,
      parameters: { events: true, revenue: true, compare: true, allowFilter: true, ...parameters },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  state.auth = share();
  state.parseError = 0;
  state.parseRequest.mockImplementation(async (input: Request, schema?: any) => {
    if (state.parseError) return { error: () => Response.json({}, { status: state.parseError }) };
    const raw = Object.fromEntries(new URL(input.url).searchParams);
    const parsed = schema?.safeParse(raw) ?? { success: true, data: raw };
    if (!parsed.success) return { error: () => Response.json({}, { status: 400 }) };
    return { auth: state.auth, query: parsed.data };
  });
  state.filters.mockResolvedValue({
    startDate: new Date('2026-11-01'),
    endDate: new Date('2026-11-02'),
  });
  state.eventRows.mockResolvedValue({ data: [], count: 0, page: 1, pageSize: 20 });
  state.eventById.mockResolvedValue([]);
  state.pivot.mockResolvedValue({ data: [], count: 0 });
  state.revenue.mockResolvedValue({ data: [], count: 0 });
  state.values.mockResolvedValue([{ value: 'verified' }]);
  state.sessionProperties.mockResolvedValue([]);
});

describe.each(endpoints)('%s share row boundary', (_name, handler, query, section) => {
  test.each([ENTITY_TYPE.board, ENTITY_TYPE.link, ENTITY_TYPE.pixel])(
    'aggregate-only share type %s cannot read individual rows',
    async shareType => {
      state.auth = share(shareType);
      expect((await handler(request(), context)).status).toBe(401);
      expect(query).not.toHaveBeenCalled();
      expect(state.filters).not.toHaveBeenCalled();
    },
  );
  test('website shares retain enabled row access without caching private output', async () => {
    const response = await handler(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(query).toHaveBeenCalledOnce();
  });
  test('a disabled website section denies rows before querying', async () => {
    state.auth = share(ENTITY_TYPE.website, { [section]: false });
    expect((await handler(request(), context)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  test('independently authorized owners retain access', async () => {
    state.auth = { user: { id: 'owner' } };
    expect((await handler(request(), context)).status).toBe(200);
    expect(query).toHaveBeenCalledOnce();
  });
  test('unrelated sessions do not upgrade a restricted share', async () => {
    state.auth = { ...share(ENTITY_TYPE.website, { [section]: false }), user: { id: 'unrelated' } };
    expect((await handler(request(), context)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  test('admission errors return before any data read', async () => {
    state.parseError = 429;
    expect((await handler(request(), context)).status).toBe(429);
    expect(query).not.toHaveBeenCalled();
  });
});

test('raw event lookup validates both identifiers before storage', async () => {
  for (const params of [
    { websiteId: 'invalid', eventId },
    { websiteId, eventId: 'invalid' },
  ]) {
    expect((await getEventById(request(), { params: Promise.resolve(params) })).status).toBe(400);
  }
  expect(state.eventById).not.toHaveBeenCalled();
});

test('shared event lookup preserves the row sentinel', async () => {
  state.eventById.mockResolvedValue(Array(501).fill({ value: 'bounded' }));
  expect((await getEventById(request(), context)).status).toBe(400);
  expect(state.eventById).toHaveBeenCalledWith(websiteId, eventId, 501);
});

test('raw property and pivot schemas accept period-only queries and reject mixed dates', async () => {
  for (const handler of [getEventRows, getEventPivot]) {
    await handler(request(), context);
    const schema = state.parseRequest.mock.lastCall[1];
    expect(schema.safeParse({ period: 'today', eventName: 'purchase' }).success).toBe(true);
    expect(
      schema.safeParse({ period: 'today', startAt: 1, endAt: 2, eventName: 'purchase' }).success,
    ).toBe(false);
    expect(schema.safeParse({ startAt: 1, eventName: 'purchase' }).success).toBe(false);
    const options = state.parseRequest.mock.lastCall[2];
    expect(options.capShareCount).toBe(true);
    expect(options.shareQueryWorkMultiplier({ page: 10001, pageSize: 100 })).toBeNull();
  }
});

test('compare-only shares cannot enumerate visitor identity labels', async () => {
  state.auth = share(ENTITY_TYPE.website, { sessions: false });
  expect((await getValues(request(), context)).status).toBe(401);
  expect(state.values).not.toHaveBeenCalled();
  state.auth = share(ENTITY_TYPE.website, { sessions: true });
  const response = await getValues(request(), context);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(state.values).toHaveBeenCalledOnce();
});

test('session properties retain board exclusion and website section checks', async () => {
  const params = { params: Promise.resolve({ websiteId, sessionId: eventId }) };
  for (const auth of [
    share(ENTITY_TYPE.board, { sessions: true }),
    share(ENTITY_TYPE.website, { sessions: false }),
  ]) {
    state.auth = auth;
    expect((await getSessionProperties(request(), params)).status).toBe(401);
    expect(state.sessionProperties).not.toHaveBeenCalled();
  }
  state.auth = share(ENTITY_TYPE.website, { sessions: true });
  const response = await getSessionProperties(request(), params);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(state.sessionProperties).toHaveBeenCalledWith(
    websiteId,
    eventId,
    MAX_SHARE_SESSION_ROWS + 1,
  );
});

test('session property overflows and malformed identifiers fail before exposing data', async () => {
  state.auth = share(ENTITY_TYPE.website, { sessions: true });
  expect(
    (
      await getSessionProperties(request(), {
        params: Promise.resolve({ websiteId, sessionId: 'invalid' }),
      })
    ).status,
  ).toBe(400);
  expect(state.sessionProperties).not.toHaveBeenCalled();
  state.sessionProperties.mockResolvedValue(Array(MAX_SHARE_SESSION_ROWS + 1).fill({}));
  expect(
    (
      await getSessionProperties(request(), {
        params: Promise.resolve({ websiteId, sessionId: eventId }),
      })
    ).status,
  ).toBe(400);
});
