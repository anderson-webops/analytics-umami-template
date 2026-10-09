import { describe, expect, test } from 'vitest';
import type { Board } from '@/generated/prisma/client';
import { ENTITY_TYPE } from '@/lib/constants';
import { isSharedEntityApiRequestAllowed } from './share-api-access';

const board = {
  type: 'mixed',
  parameters: {
    rows: [
      {
        columns: [
          {
            component: {
              type: 'MetricsTable',
              entityType: 'website',
              entityId: 'site-1',
              props: { type: 'country' },
            },
          },
          { component: { type: 'WebsiteChart', entityType: 'website', entityId: 'site-2' } },
          {
            component: {
              type: 'Goal',
              entityType: 'website',
              entityId: 'site-1',
              props: { reportId: 'goal-1' },
            },
          },
          { component: { type: 'WebsiteMetricsBar', entityType: 'pixel', entityId: 'pixel-1' } },
          { component: { type: 'RealtimeChart', entityType: 'website', entityId: 'site-2' } },
        ],
      },
    ],
  },
} as unknown as Board;

const ids = {
  boardId: 'board-1',
  websiteIds: ['site-1', 'site-2'],
  pixelIds: ['pixel-1'],
  linkIds: [],
};

function boardWith(component: unknown): Board {
  return {
    type: 'mixed',
    parameters: { rows: [{ columns: [{ component }] }] },
  } as unknown as Board;
}

function allowedForBoard(path: string, entity: Board) {
  return isSharedEntityApiRequestAllowed(
    new Request(`http://localhost${path}`),
    ENTITY_TYPE.board,
    entity,
    ids,
  );
}

function allowed(path: string, shareType = ENTITY_TYPE.board, method = 'GET') {
  return isSharedEntityApiRequestAllowed(
    new Request(`http://localhost${path}`, { method }),
    shareType,
    board,
    ids,
  );
}

describe('board share API capabilities', () => {
  test('keeps only the current board and represented component queries available', () => {
    for (const path of [
      '/api/boards/board-1',
      '/api/websites/site-1',
      '/api/websites/site-1/daterange',
      '/api/websites/site-1/metrics?type=country',
      '/api/websites/site-1/goals/goal-1',
      '/api/websites/site-1/goals/goal-1/stats',
      '/api/websites/site-2/pageviews',
      '/api/realtime/site-2/series',
      '/api/pixels/pixel-1',
      '/api/websites/pixel-1/stats/traffic',
    ]) {
      expect(allowed(path), path).toBe(true);
    }
  });

  test('rejects raw data, siblings, unrepresented metrics, and mutations', () => {
    for (const path of [
      '/api/boards/board-2',
      '/api/websites/site-1/sessions',
      '/api/websites/site-1/sessions/session-1',
      '/api/websites/site-1/event-data',
      '/api/websites/site-1/event-data/stats',
      '/api/websites/site-1/revenue/stats',
      '/api/websites/site-1/replays',
      '/api/websites/site-1/metrics?type=distinctId',
      '/api/websites/site-1/metrics?type=country&type=distinctId',
      '/api/websites/site-1/metrics/expanded?type=country',
      '/api/websites/site-1/pageviews',
      '/api/websites/site-2/metrics?type=country',
      '/api/websites/site-2/goals/goal-1',
      '/api/websites/site-1/goals/goal-2/stats',
      '/api/websites/pixel-1/metrics?type=country',
      '/api/websites/pixel-1/stats',
      '/api/websites/site-3/metrics?type=country',
      '/api/realtime/site-1',
      '/api/realtime/site-2',
      '/api/realtime/site-2/totals',
      '/api/websites/site-1/values?type=distinctId',
      '/api/websites/site-1/annotations',
      '/api/websites/site-1/metrics%2F..%2Fsessions?type=country',
      '/api/websites/site-1/stats?distinctId=visitor-1',
      '/api/websites/site-1/metrics?type=country&pf_secret=1.eq.value',
      '/api/websites/site-1/metrics?type=country&distinctId1=visitor-1',
      '/api/websites/site-1/metrics?type=country&referrer=eq.example',
      '/api/websites/site-1/metrics?type=country&referrer1=eq.example',
      '/api/websites/charts?ids=site-1',
      '/api/websites/charts?ids=site-1,site-3',
      '/api/websites/charts?ids=site-1&ids=site-2',
      '/api/links/charts?ids=link-1',
    ]) {
      expect(allowed(path), path).toBe(false);
    }

    expect(allowed('/api/websites/site-1/metrics?type=country', ENTITY_TYPE.board, 'POST')).toBe(
      false,
    );
  });

  test('never grants an entity based only on an overridden component prop', () => {
    const spoofed = {
      ...board,
      parameters: {
        rows: [
          {
            columns: [
              {
                component: {
                  type: 'WebsiteChart',
                  entityType: 'website',
                  entityId: 'site-1',
                  props: { websiteId: 'site-2' },
                },
              },
            ],
          },
        ],
      },
    } as unknown as Board;
    const request = new Request('http://localhost/api/websites/site-2/pageviews');
    expect(isSharedEntityApiRequestAllowed(request, ENTITY_TYPE.board, spoofed, ids)).toBe(false);
  });

  test('a component may repeat its resolved entity without changing the grant', () => {
    const entity = boardWith({
      type: 'WebsiteChart',
      entityType: 'website',
      entityId: 'site-1',
      props: { websiteId: 'site-1' },
    });
    expect(allowedForBoard('/api/websites/site-1/pageviews', entity)).toBe(true);
    expect(allowedForBoard('/api/websites/site-2/pageviews', entity)).toBe(false);
  });

  test('board widgets cannot open an expanded view that the board does not render', () => {
    const expandedBoard = {
      ...board,
      parameters: {
        rows: [
          {
            columns: [
              {
                component: {
                  type: 'MetricsTable',
                  entityType: 'website',
                  entityId: 'site-1',
                  props: { type: 'country', showMore: true },
                },
              },
            ],
          },
        ],
      },
    } as unknown as Board;

    expect(
      isSharedEntityApiRequestAllowed(
        new Request('http://localhost/api/websites/site-1/metrics/expanded?type=country'),
        ENTITY_TYPE.board,
        expandedBoard,
        ids,
      ),
    ).toBe(false);
  });

  test('a map cannot request a hidden list chart or a different metric page size', () => {
    const entity = boardWith({ type: 'WorldMap', entityType: 'website', entityId: 'site-1' });
    expect(allowedForBoard('/api/websites/site-1/metrics?type=country', entity)).toBe(true);
    for (const path of [
      '/api/websites/charts?ids=site-1',
      '/api/websites/site-1/metrics?type=country&limit=500',
    ]) {
      expect(allowedForBoard(path, entity), path).toBe(false);
    }
  });

  test('a metrics table cannot expand its configured rows or page beyond them', () => {
    const entity = boardWith({
      type: 'MetricsTable',
      entityType: 'website',
      entityId: 'site-1',
      props: { type: 'country', limit: 10 },
    });
    expect(allowedForBoard('/api/websites/site-1/metrics?type=country&limit=10', entity)).toBe(
      true,
    );
    for (const path of [
      '/api/websites/site-1/metrics?type=country',
      '/api/websites/site-1/metrics?type=country&limit=500',
      '/api/websites/site-1/metrics?type=country&limit=10&offset=10',
    ]) {
      expect(allowedForBoard(path, entity), path).toBe(false);
    }
  });

  test('API-authored metric overrides cannot grant a different hidden query', () => {
    const overridden = boardWith({
      type: 'MetricsTable',
      entityType: 'website',
      entityId: 'site-1',
      props: { type: 'country', limit: 10, params: { type: 'browser', limit: 5 } },
    });
    expect(allowedForBoard('/api/websites/site-1/metrics?type=browser&limit=5', overridden)).toBe(
      true,
    );
    expect(allowedForBoard('/api/websites/site-1/metrics?type=country&limit=10', overridden)).toBe(
      false,
    );

    const filtered = boardWith({
      type: 'MetricsTable',
      entityType: 'website',
      entityId: 'site-1',
      props: { type: 'country', params: { path: 'eq./private' } },
    });
    expect(allowedForBoard('/api/websites/site-1/metrics?type=country', filtered)).toBe(false);
    expect(
      allowedForBoard('/api/websites/site-1/metrics?type=country&path=eq./private', filtered),
    ).toBe(false);
  });

  test('API-authored params cannot grant an unfiltered sibling chart', () => {
    const filtered = boardWith({
      type: 'WebsiteChart',
      entityType: 'website',
      entityId: 'site-1',
      props: { params: { path: 'eq./private' } },
    });
    expect(allowedForBoard('/api/websites/site-1/pageviews', filtered)).toBe(false);
  });

  test('an events chart can request only its configured event-series limit', () => {
    const defaultChart = boardWith({
      type: 'EventsChart',
      entityType: 'website',
      entityId: 'site-1',
    });
    const expandedChart = boardWith({
      type: 'EventsChart',
      entityType: 'website',
      entityId: 'site-1',
      props: { limit: 100 },
    });

    expect(allowedForBoard('/api/websites/site-1/events/series', defaultChart)).toBe(true);
    expect(allowedForBoard('/api/websites/site-1/events/series?limit=50', defaultChart)).toBe(true);
    expect(allowedForBoard('/api/websites/site-1/events/series?limit=500', defaultChart)).toBe(
      false,
    );
    expect(allowedForBoard('/api/websites/site-1/events/series?limit=100', expandedChart)).toBe(
      true,
    );
    expect(allowedForBoard('/api/websites/site-1/events/series', expandedChart)).toBe(false);
    expect(
      allowedForBoard('/api/websites/site-1/events/series?limit=100&limit=100', expandedChart),
    ).toBe(false);
  });

  test('each realtime board component grants only its rendered response', () => {
    const header = boardWith({ type: 'RealtimeHeader', entityType: 'website', entityId: 'site-1' });
    const chart = boardWith({ type: 'RealtimeChart', entityType: 'website', entityId: 'site-1' });

    expect(allowedForBoard('/api/realtime/site-1/totals', header)).toBe(true);
    expect(allowedForBoard('/api/realtime/site-1/series', header)).toBe(false);
    expect(allowedForBoard('/api/realtime/site-1/series', chart)).toBe(true);
    expect(allowedForBoard('/api/realtime/site-1/totals', chart)).toBe(false);
    expect(allowedForBoard('/api/realtime/site-1', header)).toBe(false);
    expect(allowedForBoard('/api/realtime/site-1', chart)).toBe(false);
  });

  test('a revenue table grants only its currency, metric, and ten displayed rows', () => {
    const entity = boardWith({
      type: 'RevenueMetricsTable',
      entityType: 'website',
      entityId: 'site-1',
      props: { type: 'referrer', currency: 'USD' },
    });
    expect(allowedForBoard('/api/websites/site-1/revenue/stats?currency=USD', entity)).toBe(false);
    expect(allowedForBoard('/api/websites/site-1/revenue/total?currency=USD', entity)).toBe(true);
    expect(
      allowedForBoard(
        '/api/websites/site-1/revenue/metrics?type=referrer&currency=USD&limit=10',
        entity,
      ),
    ).toBe(true);
    for (const path of [
      '/api/websites/site-1/revenue/stats?currency=EUR',
      '/api/websites/site-1/revenue/total?currency=EUR',
      '/api/websites/site-1/revenue/total?currency=USD&currency=USD',
      '/api/websites/site-1/revenue/total?currency=USD&only=sum',
      '/api/websites/site-1/revenue/metrics?type=referrer&currency=USD',
      '/api/websites/site-1/revenue/metrics?type=referrer&currency=USD&limit=20',
      '/api/websites/site-1/revenue/metrics?type=channel&currency=USD&limit=10',
    ]) {
      expect(allowedForBoard(path, entity), path).toBe(false);
    }
  });

  test('a revenue bar can request full stats while a table cannot', () => {
    const entity = boardWith({
      type: 'RevenueMetricsBar',
      entityType: 'website',
      entityId: 'site-1',
      props: { currency: 'USD' },
    });
    expect(allowedForBoard('/api/websites/site-1/revenue/stats?currency=USD', entity)).toBe(true);
    expect(allowedForBoard('/api/websites/site-1/revenue/total?currency=USD', entity)).toBe(false);
  });

  test('a UTM component grants only its configured dimension and displayed rows', () => {
    const entity = boardWith({
      type: 'UTM',
      entityType: 'website',
      entityId: 'site-1',
      props: { param: 'utm_source', limit: 10 },
    });
    expect(
      allowedForBoard('/api/websites/site-1/utm/metrics?type=utm_source&limit=10', entity),
    ).toBe(true);
    for (const path of [
      '/api/websites/site-1/utm/metrics?type=utm_source',
      '/api/websites/site-1/utm/metrics?type=utm_source&limit=20',
      '/api/websites/site-1/utm/metrics?type=utm_medium&limit=10',
    ]) {
      expect(allowedForBoard(path, entity), path).toBe(false);
    }
  });
});

describe('link and pixel share API capabilities', () => {
  for (const [shareType, entityId, route] of [
    [ENTITY_TYPE.link, 'link-1', 'links'],
    [ENTITY_TYPE.pixel, 'pixel-1', 'pixels'],
  ] as const) {
    test(`${route} retain displayed aggregates without website-wide access`, () => {
      const access = { linkId: 'link-1', pixelId: 'pixel-1' };
      const check = (path: string, method = 'GET') =>
        isSharedEntityApiRequestAllowed(
          new Request(`http://localhost${path}`, { method }),
          shareType,
          {},
          access,
        );

      for (const path of [
        `/api/${route}/${entityId}`,
        `/api/websites/${entityId}/stats/traffic`,
        `/api/websites/${entityId}/pageviews`,
        `/api/websites/${entityId}/daterange`,
        `/api/websites/${entityId}/metrics?type=country`,
        `/api/websites/${entityId}/metrics/expanded?type=referrer`,
        `/api/websites/${entityId}/metrics/expanded?type=referrer&search=example`,
      ]) {
        expect(check(path), path).toBe(true);
      }

      for (const path of [
        `/api/websites/${entityId}/sessions`,
        `/api/websites/${entityId}/event-data`,
        `/api/websites/${entityId}/stats`,
        `/api/websites/${entityId}/revenue/stats`,
        `/api/websites/${entityId}/metrics?type=distinctId`,
        `/api/websites/${entityId}/metrics?type=country&type=browser`,
        `/api/websites/${entityId}/metrics/expanded?type=query`,
        `/api/websites/${entityId}/values?type=country`,
        `/api/websites/${entityId}/pageviews?distinctId=visitor-1`,
        `/api/websites/${entityId}/pageviews?distinctId1=visitor-1`,
        `/api/websites/${entityId}/metrics?type=country&spf1=secret.eq.value`,
        `/api/websites/${entityId}/metrics?type=country&referrer=eq.example`,
        `/api/websites/${entityId}/metrics?type=country&referrer1=eq.example`,
        `/api/${route}/charts?ids=${entityId}`,
        `/api/${route}/charts?ids=${entityId},other`,
        `/api/${route}/charts?ids=other`,
        `/api/${route}/charts?ids=${entityId}&ids=${entityId}`,
        `/api/${route}/charts?ids=${entityId}&foo=bar`,
        '/api/websites/other/stats',
      ]) {
        expect(check(path), path).toBe(false);
      }
      expect(check(`/api/websites/${entityId}/stats/traffic`, 'DELETE')).toBe(false);
    });
  }
});
