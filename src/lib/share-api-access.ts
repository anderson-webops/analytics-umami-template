import type { Board } from '@/generated/prisma/client';
import { getCanonicalApiPath } from '@/lib/api-key';
import {
  type BoardEntityType,
  getBoardEntity,
  getFirstBoardComponentEntity,
  getResolvedComponentEntity,
  isBoardComponentSupported,
} from '@/lib/boards';
import { DEFAULT_CURRENCY, ENTITY_TYPE } from '@/lib/constants';
import { excludeShareFilterParam } from '@/lib/share-filter';
import type { BoardComponentConfig, BoardParameters } from '@/lib/types';

type SharedEntityIds = {
  boardId?: string;
  pixelId?: string;
  linkId?: string;
  websiteIds?: string[];
  pixelIds?: string[];
  linkIds?: string[];
};

const LINK_PIXEL_METRICS = new Set([
  'referrer',
  'channel',
  'browser',
  'os',
  'device',
  'country',
  'region',
  'city',
]);

const WEBSITE_METRICS = new Set([
  'path',
  'fullPath',
  'entry',
  'exit',
  'title',
  'query',
  'referrer',
  'channel',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'language',
  'screen',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
  'event',
  'hostname',
]);

const UTM_METRICS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
]);

const REVENUE_METRICS = new Set(['referrer', 'channel', 'country', 'region']);
const MAX_BOARD_UTM_ROWS = 20;
const BOARD_REVENUE_ROWS = 10;
const DEFAULT_BOARD_EVENT_SERIES_LIMIT = 50;
const MAX_BOARD_EVENT_SERIES_LIMIT = 500;

function boardMetricGrant(metric: string, limit: number | null) {
  return `metrics:${JSON.stringify([metric, limit])}`;
}

function boardRevenueGrant(operation: string, currency: string, metric?: string) {
  return `revenue:${JSON.stringify([operation, currency, metric ?? null])}`;
}

function boardUtmGrant(metric: string, limit: number) {
  return `utm/metrics:${JSON.stringify([metric, limit])}`;
}

function getBoardRevenueCurrency(value: unknown) {
  return typeof value === 'string' && value.length > 0
    ? value
    : process.env.defaultCurrency || DEFAULT_CURRENCY;
}

function getRequestedMetricLimit(query: URLSearchParams): number | null | undefined {
  const values = query.getAll('limit');
  if (values.length === 0) return null;
  if (values.length !== 1) return undefined;

  const limit = Number(values[0]);
  return String(limit) === values[0] && Number.isInteger(limit) && limit > 0 && limit <= 500
    ? limit
    : undefined;
}

function isAuthorizedEntity(ids: SharedEntityIds, entityType: BoardEntityType, entityId: string) {
  if (entityType === 'website') return ids.websiteIds?.includes(entityId) === true;
  if (entityType === 'pixel') return ids.pixelIds?.includes(entityId) === true;
  if (entityType === 'link') return ids.linkIds?.includes(entityId) === true;
  return false;
}

function getBoardGrants(board: Pick<Board, 'type' | 'parameters'>, ids: SharedEntityIds) {
  const grants = new Map<string, Set<string>>();
  const parameters = board.parameters as BoardParameters;
  const add = (
    entityType: BoardEntityType | undefined,
    entityId: string | undefined,
    grant: string,
  ) => {
    if (!entityType || !entityId || !isAuthorizedEntity(ids, entityType, entityId)) return;
    const existing = grants.get(entityId) ?? new Set<string>();
    existing.add(grant);
    existing.add(`metadata:${entityType}`);
    grants.set(entityId, existing);
  };

  const boardEntity = getBoardEntity({ type: board.type, parameters });
  const fallbackEntity = getFirstBoardComponentEntity({ type: board.type, parameters });
  const controls = boardEntity.entityId ? boardEntity : fallbackEntity;
  add(controls.entityType, controls.entityId, 'daterange');

  for (const row of parameters?.rows ?? []) {
    for (const column of row.columns ?? []) {
      const component: BoardComponentConfig | undefined = column.component;
      if (!component || component.type === 'TextBlock') continue;

      const { entityType, entityId } = getResolvedComponentEntity(
        { type: board.type, parameters },
        component,
      );
      if (!entityType || !entityId || !isBoardComponentSupported(component.type, entityType)) {
        continue;
      }

      const props = component.props ?? {};
      if (
        (Object.hasOwn(props, 'websiteId') && props.websiteId !== entityId) ||
        Object.hasOwn(props, 'pixelId') ||
        Object.hasOwn(props, 'linkId')
      ) {
        continue;
      }
      if (component.type !== 'MetricsTable' && props.params && Object.keys(props.params).length) {
        continue;
      }

      switch (component.type) {
        case 'WebsiteMetricsBar':
          add(entityType, entityId, entityType === 'website' ? 'stats' : 'stats:traffic');
          break;
        case 'EventsMetricsBar':
          add(entityType, entityId, 'events/stats');
          break;
        case 'WebsiteChart':
          add(entityType, entityId, 'pageviews');
          break;
        case 'RealtimeHeader':
          add(entityType, entityId, 'realtime:totals');
          break;
        case 'RealtimeChart':
          add(entityType, entityId, 'realtime:series');
          break;
        case 'RealtimeActiveUsers':
          add(entityType, entityId, 'active');
          break;
        case 'RevenueMetricsBar':
          add(
            entityType,
            entityId,
            boardRevenueGrant('stats', getBoardRevenueCurrency(props.currency)),
          );
          break;
        case 'RevenueChart':
          add(
            entityType,
            entityId,
            boardRevenueGrant('chart', getBoardRevenueCurrency(props.currency)),
          );
          break;
        case 'RevenueMetricsTable': {
          const metric = props.type ?? 'referrer';
          if (!REVENUE_METRICS.has(metric)) break;
          const currency = getBoardRevenueCurrency(props.currency);
          add(entityType, entityId, boardRevenueGrant('total', currency));
          add(entityType, entityId, boardRevenueGrant('metrics', currency, metric));
          break;
        }
        case 'MetricsTable': {
          const params = props.params;
          if (
            params &&
            (typeof params !== 'object' ||
              Array.isArray(params) ||
              Object.keys(params).some(key => !['type', 'limit'].includes(key)))
          ) {
            break;
          }
          const metric = params?.type ?? props.type ?? 'path';
          const allowedMetrics = entityType === 'website' ? WEBSITE_METRICS : LINK_PIXEL_METRICS;
          if (!allowedMetrics.has(metric)) break;
          const requestedLimit = params?.limit ?? props.limit;
          const limit = requestedLimit === undefined ? null : Number(requestedLimit);
          if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 500)) break;
          add(entityType, entityId, boardMetricGrant(metric, limit));
          break;
        }
        case 'WorldMap':
          add(entityType, entityId, boardMetricGrant('country', null));
          break;
        case 'WeeklyTraffic':
          add(entityType, entityId, 'sessions/weekly');
          break;
        case 'EventsChart': {
          const limit =
            props.limit === undefined ? DEFAULT_BOARD_EVENT_SERIES_LIMIT : Number(props.limit);
          if (Number.isInteger(limit) && limit > 0 && limit <= MAX_BOARD_EVENT_SERIES_LIMIT) {
            add(entityType, entityId, `events/series:${limit}`);
          }
          break;
        }
        case 'UTM': {
          const metric = props.param ?? 'utm_source';
          const limit = Number(props.limit) || 10;
          if (
            UTM_METRICS.has(metric) &&
            Number.isInteger(limit) &&
            limit > 0 &&
            limit <= MAX_BOARD_UTM_ROWS
          ) {
            add(entityType, entityId, boardUtmGrant(metric, limit));
          }
          break;
        }
        case 'Goal':
        case 'Funnel': {
          const reportId = props.reportId;
          if (typeof reportId === 'string' && reportId.length > 0) {
            add(entityType, entityId, `${component.type.toLowerCase()}:${reportId}`);
          }
          break;
        }
      }
    }
  }

  return grants;
}

function getRequestedGrant(path: string[], query: URLSearchParams) {
  const [, , , , operation, detail, reportAction] = path;

  if (path.length === 5) {
    if (['stats', 'pageviews', 'daterange', 'active'].includes(operation)) return operation;
    if (operation === 'metrics' && query.getAll('type').length === 1 && !query.has('offset')) {
      const limit = getRequestedMetricLimit(query);
      return limit === undefined ? null : boardMetricGrant(query.get('type') ?? '', limit);
    }
    return null;
  }

  if (path.length === 6) {
    if (operation === 'stats' && detail === 'traffic') return 'stats:traffic';
    if (operation === 'metrics' && detail === 'expanded') {
      return query.getAll('type').length === 1 ? `metrics/expanded:${query.get('type')}` : null;
    }
    if (operation === 'events' && detail === 'stats') return 'events/stats';
    if (operation === 'events' && detail === 'series') {
      const values = query.getAll('limit');
      if (values.length > 1) return null;
      const limit = values.length === 0 ? DEFAULT_BOARD_EVENT_SERIES_LIMIT : Number(values[0]);
      return Number.isInteger(limit) &&
        limit > 0 &&
        limit <= MAX_BOARD_EVENT_SERIES_LIMIT &&
        (values.length === 0 || String(limit) === values[0])
        ? `events/series:${limit}`
        : null;
    }
    if (operation === 'sessions' && detail === 'weekly') return 'sessions/weekly';
    if (
      operation === 'revenue' &&
      ['stats', 'total'].includes(detail) &&
      query.getAll('currency').length === 1 &&
      !query.has('only')
    ) {
      return boardRevenueGrant(detail, query.get('currency') ?? '');
    }
    if (
      operation === 'revenue' &&
      detail === 'chart' &&
      query.getAll('currency').length === 1 &&
      !query.has('only')
    ) {
      return boardRevenueGrant(detail, query.get('currency') ?? '');
    }
    if (operation === 'revenue' && detail === 'metrics') {
      return query.getAll('type').length === 1 &&
        query.getAll('currency').length === 1 &&
        query.getAll('limit').length === 1 &&
        query.get('limit') === String(BOARD_REVENUE_ROWS)
        ? boardRevenueGrant('metrics', query.get('currency') ?? '', query.get('type') ?? '')
        : null;
    }
    if (operation === 'utm' && detail === 'metrics') {
      const limit = Number(query.get('limit'));
      return query.getAll('type').length === 1 &&
        query.getAll('limit').length === 1 &&
        String(limit) === query.get('limit') &&
        Number.isInteger(limit) &&
        limit > 0 &&
        limit <= MAX_BOARD_UTM_ROWS
        ? boardUtmGrant(query.get('type') ?? '', limit)
        : null;
    }
  }

  if (path.length === 7 && ['goals', 'funnels'].includes(operation)) {
    const reportType = operation === 'goals' ? 'goal' : 'funnel';
    if (reportAction === 'stats') return `${reportType}:${detail}`;
  }

  if (path.length === 6 && ['goals', 'funnels'].includes(operation)) {
    return `${operation === 'goals' ? 'goal' : 'funnel'}:${detail}`;
  }

  return null;
}

export function isSharedEntityApiRequestAllowed(
  request: Request,
  shareType: number,
  entity: unknown,
  ids: SharedEntityIds,
) {
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) return false;

  const url = new URL(request.url);
  if (/%|\\|\/{2,}|(?:^|\/)\.{1,2}(?:\/|$)/.test(url.pathname)) return false;
  const path = getCanonicalApiPath(url.pathname).split('/');
  if (path[1] !== 'api') return false;

  const isExpandedMetrics =
    path.length === 6 && path[2] === 'websites' && path[4] === 'metrics' && path[5] === 'expanded';
  if (
    [...url.searchParams.keys()].some(key => {
      return excludeShareFilterParam(key) && !(isExpandedMetrics && key === 'search');
    })
  ) {
    return false;
  }

  if (shareType === ENTITY_TYPE.link || shareType === ENTITY_TYPE.pixel) {
    const entityType = shareType === ENTITY_TYPE.link ? 'link' : 'pixel';
    const entityId = entityType === 'link' ? ids.linkId : ids.pixelId;
    if (!entityId) return false;
    if (path.length === 4 && path[2] === `${entityType}s` && path[3] === entityId) return true;
    if (path[2] !== 'websites' || path[3] !== entityId) return false;
    if (path.length === 5 && ['pageviews', 'daterange'].includes(path[4])) return true;
    if (path.length === 6 && path[4] === 'stats' && path[5] === 'traffic') return true;
    if (path.length === 5 && path[4] === 'metrics') {
      return (
        url.searchParams.getAll('type').length === 1 &&
        LINK_PIXEL_METRICS.has(url.searchParams.get('type') ?? '')
      );
    }
    return (
      path.length === 6 &&
      path[4] === 'metrics' &&
      path[5] === 'expanded' &&
      url.searchParams.getAll('type').length === 1 &&
      LINK_PIXEL_METRICS.has(url.searchParams.get('type') ?? '')
    );
  }

  if (shareType !== ENTITY_TYPE.board || !ids.boardId) return false;
  if (path.length === 4 && path[2] === 'boards' && path[3] === ids.boardId) return true;

  const grants = getBoardGrants(entity as Board, ids);
  if (path.length === 4 && ['websites', 'links', 'pixels'].includes(path[2])) {
    const entityType = path[2] === 'websites' ? 'website' : path[2] === 'links' ? 'link' : 'pixel';
    return grants.get(path[3])?.has(`metadata:${entityType}`) === true;
  }
  if (path.length === 5 && path[2] === 'realtime') {
    return (
      ['totals', 'series'].includes(path[4]) &&
      grants.get(path[3])?.has(`realtime:${path[4]}`) === true
    );
  }
  if (path[2] !== 'websites' || path.length < 5) return false;

  const grant = getRequestedGrant(path, url.searchParams);
  return !!grant && grants.get(path[3])?.has(grant) === true;
}
