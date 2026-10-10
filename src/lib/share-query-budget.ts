import { DEFAULT_PAGE_SIZE, FILTER_COLUMNS, OPERATORS } from '@/lib/constants';
import { hash } from '@/lib/crypto';
import { getAllowedUnits, getMinimumUnit } from '@/lib/date';
import {
  parseFilterValue,
  parsePropertyFilters,
  parseSessionPropertyFilters,
  parseUniversalEventPropertyFilters,
} from '@/lib/params';
import redis from '@/lib/redis';
import { getConservativeSeriesBucketCount } from '@/lib/series-budget';
import { excludeShareFilterParam } from '@/lib/share-filter';

const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_QUERY_COST = 600;
const MAX_WORK_MULTIPLIER = 1024;
const MAX_AUTH_QUERY_COST = 20_000;
const MAX_AUTH_WINDOW_COST = 20_000;
const MAX_AUTH_WINDOW_REQUESTS = 60;
const MAX_FILTERS = 24;
const MAX_PROPERTY_FILTERS = 16;
const WINDOW_SECONDS = 60;
const MAX_WINDOW_COST = 600;
const MAX_MEMORY_COUNTERS = 20_000;
const MEMORY_COUNTERS = 'analytics-share-query-budget-counters';
const AUTH_MEMORY_COUNTERS = 'analytics-auth-query-budget-counters';
const PROPERTY_FILTER = /^(?:pf_[A-Za-z0-9_-]+|epf\d+|spf\d+)$/;
const REGEX_FILTER_WEIGHT = 200;

export const MAX_SHARE_SESSION_ROWS = 500;
export const MAX_AUTH_SESSION_ROWS = 2_000;

export type ShareQueryWorkMultiplier = number;

interface Counter {
  cost: number;
  expiresAt: number;
}

interface AuthCounter extends Counter {
  requests: number;
}

function isRegexFilter(key: string, value: unknown) {
  if (typeof value !== 'string') return false;

  const operator = key.startsWith('pf_')
    ? parsePropertyFilters({ [key]: value })[0]?.operator
    : /^epf\d+$/.test(key)
      ? parseUniversalEventPropertyFilters({ [key]: value })[0]?.operator
      : /^spf\d+$/.test(key)
        ? parseSessionPropertyFilters({ [key]: value })[0]?.operator
        : Object.hasOwn(FILTER_COLUMNS, key.replace(/\d+$/, ''))
          ? parseFilterValue(value).operator
          : undefined;

  return operator === OPERATORS.regex || operator === OPERATORS.notRegex;
}

function filterCost(values: Record<string, unknown>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => {
      if (PROPERTY_FILTER.test(key)) {
        result.filters += 1;
        result.properties += 1;
        result.weight += isRegexFilter(key, value) ? REGEX_FILTER_WEIGHT : 4;
      } else if (key === 'segment' || key === 'cohort') {
        result.filters += 1;
        result.weight += 400;
      } else if (excludeShareFilterParam(key)) {
        result.filters += 1;
        result.weight += isRegexFilter(key, value) ? REGEX_FILTER_WEIGHT : 1;
      }

      return result;
    },
    { filters: 0, properties: 0, weight: 0 },
  );
}

function getDateRange(query: Record<string, unknown>, body: unknown) {
  const parameters =
    body && typeof body === 'object' && 'parameters' in body
      ? (body as { parameters?: Record<string, unknown> }).parameters
      : undefined;

  if (parameters?.startDate != null && parameters.endDate != null) {
    return [
      new Date(parameters.startDate as string).getTime(),
      new Date(parameters.endDate as string).getTime(),
    ];
  }

  if (query.startAt != null && query.endAt != null) {
    return [Number(query.startAt), Number(query.endAt)];
  }

  if (query.startDate != null && query.endDate != null) {
    return [
      new Date(query.startDate as string).getTime(),
      new Date(query.endDate as string).getTime(),
    ];
  }

  return null;
}

export function getStepFilterCount(value: unknown) {
  if (!Array.isArray(value)) return 0;

  return value.reduce(
    (count, step) => count + (Array.isArray(step?.filters) ? step.filters.length : 0),
    0,
  );
}

export function getFunnelShareWorkMultiplier(steps: unknown, window: unknown): number | null {
  if (
    !Array.isArray(steps) ||
    steps.length < 2 ||
    steps.length > 8 ||
    typeof window !== 'number' ||
    !Number.isSafeInteger(window) ||
    window < 1 ||
    window > 525_600
  ) {
    return null;
  }

  let expensivePredicates = 0;

  for (const step of steps) {
    if (!step || typeof step !== 'object' || typeof step.value !== 'string') {
      return null;
    }

    if (step.value.startsWith('*') || step.value.endsWith('*')) {
      expensivePredicates += 1;
    }

    if (step.filters != null) {
      if (!Array.isArray(step.filters)) {
        return null;
      }

      expensivePredicates += step.filters.filter(
        filter => filter?.operator === 'c' || filter?.operator === 'dnc',
      ).length;
    }
  }

  return steps.length * (1 + Math.ceil(window / 1440)) * (1 + expensivePredicates);
}

export function getBreakdownShareWorkMultiplier(fields: unknown): number | null {
  if (
    !Array.isArray(fields) ||
    fields.length < 1 ||
    fields.length > 20 ||
    !fields.every(field => typeof field === 'string')
  ) {
    return null;
  }

  return fields.length * 2;
}

export function getPageviewShareWorkMultiplier(compare: unknown): number | null {
  if (compare == null) {
    return 2;
  }

  return compare === 'prev' || compare === 'yoy' ? 6 : null;
}

export function getJourneyShareWorkMultiplier(steps: unknown): number | null {
  return typeof steps === 'number' && Number.isSafeInteger(steps) && steps >= 2 && steps <= 7
    ? steps * 2
    : null;
}

export function getPagedShareWorkMultiplier(page: unknown, pageSize: unknown): number | null {
  const pageNumber = page ?? 1;
  const size = pageSize ?? DEFAULT_PAGE_SIZE;

  if (
    typeof pageNumber !== 'number' ||
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > 10_000 ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 500
  ) {
    return null;
  }

  return 1 + Math.ceil((pageNumber * size) / DEFAULT_PAGE_SIZE);
}

export function getMetricShareWorkMultiplier(
  type: unknown,
  limit: unknown,
  offset: unknown,
): number | null {
  if (type === 'channel') return 1;

  const size = limit ?? 500;
  const start = offset ?? 0;

  return typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size >= 1 &&
    size <= 500 &&
    typeof start === 'number' &&
    Number.isSafeInteger(start) &&
    start >= 0 &&
    start <= 10_000
    ? 1 + Math.ceil((start + size) / 500)
    : null;
}

export function getEventSeriesShareWorkMultiplier(query: Record<string, unknown>): number | null {
  const limit = query.limit ?? 50;
  const startAt = query.startAt;
  const endAt = query.endAt;

  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    typeof startAt !== 'number' ||
    typeof endAt !== 'number' ||
    !Number.isSafeInteger(startAt) ||
    !Number.isSafeInteger(endAt) ||
    endAt < startAt
  ) {
    return null;
  }

  const startDate = new Date(startAt);
  const endDate = new Date(endAt);
  const unit = getAllowedUnits(startDate, endDate).includes(query.unit as string)
    ? (query.unit as string)
    : getMinimumUnit(startDate, endDate);
  const buckets = getConservativeSeriesBucketCount({ startDate, endDate, unit });

  return buckets > 0 && limit * buckets <= 50_000 ? 2 * Math.ceil((limit * buckets) / 500) : null;
}

export function getGoalShareWorkMultiplier(value: unknown): number | null {
  if (typeof value !== 'string') return null;

  return value.startsWith('*') || value.endsWith('*') ? 4 : 2;
}

export function getValuesShareWorkMultiplier(search: unknown): number | null {
  if (search == null || search === '') return 1;
  if (typeof search !== 'string') return null;

  try {
    return Math.min(decodeURIComponent(search).split(',').length, 5);
  } catch {
    return null;
  }
}

function getQueryCost(
  query: Record<string, unknown>,
  body: unknown,
  workMultiplier: ShareQueryWorkMultiplier | null,
  maxQueryCost: number,
  maxWindowCost: number,
) {
  if (
    typeof workMultiplier !== 'number' ||
    !Number.isSafeInteger(workMultiplier) ||
    workMultiplier < 1 ||
    workMultiplier > MAX_WORK_MULTIPLIER
  ) {
    return null;
  }

  const topLevel = filterCost(query);
  const report =
    body && typeof body === 'object' && 'filters' in body
      ? (body as { filters?: unknown }).filters
      : null;
  const reportFilters = filterCost(
    report && typeof report === 'object' && !Array.isArray(report)
      ? (report as Record<string, unknown>)
      : {},
  );
  const parameters =
    body && typeof body === 'object' && 'parameters' in body
      ? (body as { parameters?: { steps?: unknown } }).parameters
      : undefined;
  const stepFilters = getStepFilterCount(query.steps) + getStepFilterCount(parameters?.steps);
  const filters = topLevel.filters + reportFilters.filters + stepFilters;
  const properties = topLevel.properties + reportFilters.properties + stepFilters;

  if (filters > MAX_FILTERS || properties > MAX_PROPERTY_FILTERS) {
    return null;
  }

  const range = getDateRange(query, body);
  const duration = range ? range[1] - range[0] : 0;

  if (!Number.isFinite(duration) || duration < 0) {
    return null;
  }

  const months = Math.max(1, Math.ceil(duration / MONTH_MS));
  const cost = months * (1 + topLevel.weight + reportFilters.weight + stepFilters * 4);

  const charge = cost * workMultiplier;

  return Number.isSafeInteger(cost) && cost <= maxQueryCost && charge <= maxWindowCost
    ? { cost, charge }
    : null;
}

export function getShareQueryCost(
  query: Record<string, unknown>,
  body?: unknown,
  workMultiplier: ShareQueryWorkMultiplier | null = 1,
) {
  return getQueryCost(query, body, workMultiplier, MAX_QUERY_COST, MAX_WINDOW_COST);
}

export function getAuthenticatedQueryCost(
  query: Record<string, unknown>,
  body?: unknown,
  workMultiplier: ShareQueryWorkMultiplier | null = 1,
) {
  return getQueryCost(query, body, workMultiplier, MAX_AUTH_QUERY_COST, MAX_AUTH_WINDOW_COST);
}

function memoryCounters(): Map<string, Counter> {
  const state = globalThis as typeof globalThis & Record<string, any>;
  state[MEMORY_COUNTERS] ??= new Map<string, Counter>();
  return state[MEMORY_COUNTERS];
}

function authMemoryCounters(): Map<string, AuthCounter> {
  const state = globalThis as typeof globalThis & Record<string, any>;
  state[AUTH_MEMORY_COUNTERS] ??= new Map<string, AuthCounter>();
  return state[AUTH_MEMORY_COUNTERS];
}

function reserveLocal(key: string, cost: number) {
  const counters = memoryCounters();
  const now = Date.now();
  const current = counters.get(key);

  if (!current || current.expiresAt <= now) {
    for (const [storedKey, counter] of counters) {
      if (counter.expiresAt <= now) counters.delete(storedKey);
    }
    if (counters.size >= MAX_MEMORY_COUNTERS) {
      return MAX_WINDOW_COST + 1;
    }
    counters.set(key, { cost, expiresAt: now + WINDOW_SECONDS * 1000 });
    return cost;
  }

  if (current.cost + cost > MAX_WINDOW_COST) {
    return MAX_WINDOW_COST + 1;
  }

  current.cost += cost;
  return current.cost;
}

function reserveLocalAuth(key: string, cost: number, requestCount: 0 | 1) {
  const counters = authMemoryCounters();
  const now = Date.now();
  const current = counters.get(key);

  if (!current || current.expiresAt <= now) {
    for (const [storedKey, counter] of counters) {
      if (counter.expiresAt <= now) counters.delete(storedKey);
    }
    if (counters.size >= MAX_MEMORY_COUNTERS) {
      return false;
    }
    counters.set(key, { cost, requests: requestCount, expiresAt: now + WINDOW_SECONDS * 1000 });
    return true;
  }

  if (
    current.cost + cost > MAX_AUTH_WINDOW_COST ||
    current.requests + requestCount > MAX_AUTH_WINDOW_REQUESTS
  ) {
    return false;
  }

  current.cost += cost;
  current.requests += requestCount;
  return true;
}

export async function reserveShareQueryCost(shareId: string, cost: number) {
  if (!Number.isSafeInteger(cost) || cost < 1 || cost > MAX_WINDOW_COST) {
    return { blocked: true, retryAfter: WINDOW_SECONDS };
  }

  const key = `share-query-budget:${hash(shareId).slice(0, 32)}`;

  if (redis.enabled) {
    try {
      await redis.client.connect(1000);
      const total = await redis.client.client.withAbortSignal(AbortSignal.timeout(1000)).eval(
        `local current = tonumber(redis.call('GET', KEYS[1]) or '0')
         local charge = tonumber(ARGV[1])
         local capacity = tonumber(ARGV[3])
         if not current or current < 0 or current > capacity or current + charge > capacity then
           return -1
         end
         local total = redis.call('INCRBY', KEYS[1], charge)
         if current == 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
         return total`,
        { keys: [key], arguments: [String(cost), String(WINDOW_SECONDS), String(MAX_WINDOW_COST)] },
      );
      const reserved = Number(total);
      return {
        blocked: !Number.isSafeInteger(reserved) || reserved < cost || reserved > MAX_WINDOW_COST,
        retryAfter: WINDOW_SECONDS,
      };
    } catch {
      return { blocked: true, unavailable: true, retryAfter: WINDOW_SECONDS };
    }
  }

  const reservation = reserveLocal(key, cost);
  return {
    blocked: reservation > MAX_WINDOW_COST,
    retryAfter: WINDOW_SECONDS,
  };
}

export async function reserveAuthenticatedQueryCost(
  userId: string,
  cost: number,
  requestCount: 0 | 1 = 1,
) {
  if (!userId || !Number.isSafeInteger(cost) || cost < 1 || cost > MAX_AUTH_WINDOW_COST) {
    return { blocked: true, retryAfter: WINDOW_SECONDS };
  }

  const key = `auth-query-budget:${hash(userId).slice(0, 32)}`;

  if (redis.enabled) {
    try {
      await redis.client.connect(1000);
      const result = await redis.client.client.withAbortSignal(AbortSignal.timeout(1000)).eval(
        `local currentCost = tonumber(redis.call('GET', KEYS[1]) or '0')
         local currentRequests = tonumber(redis.call('GET', KEYS[2]) or '0')
         local charge = tonumber(ARGV[1])
         local requestCount = tonumber(ARGV[3])
         local maxCost = tonumber(ARGV[4])
         local maxRequests = tonumber(ARGV[5])
         if not currentCost or not currentRequests or currentCost < 0 or currentRequests < 0 or
            currentCost > maxCost or currentRequests > maxRequests or
            currentCost + charge > maxCost or currentRequests + requestCount > maxRequests then
           return -1
         end
         local total = redis.call('INCRBY', KEYS[1], charge)
         redis.call('INCRBY', KEYS[2], requestCount)
         if currentCost == 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
         if currentRequests == 0 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
         return total`,
        {
          keys: [`${key}:cost`, `${key}:requests`],
          arguments: [
            String(cost),
            String(WINDOW_SECONDS),
            String(requestCount),
            String(MAX_AUTH_WINDOW_COST),
            String(MAX_AUTH_WINDOW_REQUESTS),
          ],
        },
      );
      const reserved = Number(result);
      return {
        blocked:
          !Number.isSafeInteger(reserved) || reserved < cost || reserved > MAX_AUTH_WINDOW_COST,
        retryAfter: WINDOW_SECONDS,
      };
    } catch {
      return { blocked: true, unavailable: true, retryAfter: WINDOW_SECONDS };
    }
  }

  return {
    blocked: !reserveLocalAuth(key, cost, requestCount),
    retryAfter: WINDOW_SECONDS,
  };
}
