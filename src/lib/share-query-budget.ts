import { hash } from '@/lib/crypto';
import redis from '@/lib/redis';
import { excludeShareFilterParam } from '@/lib/share-filter';

const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_QUERY_COST = 600;
const MAX_FILTERS = 24;
const MAX_PROPERTY_FILTERS = 16;
const WINDOW_SECONDS = 60;
const MAX_WINDOW_COST = 600;
const MAX_MEMORY_COUNTERS = 20_000;
const MEMORY_COUNTERS = 'analytics-share-query-budget-counters';
const PROPERTY_FILTER = /^(?:pf_[A-Za-z0-9_-]+|epf\d+|spf\d+)$/;

export type ShareQueryWorkMultiplier = 1 | 2 | 3 | 5 | 6 | 8;

interface Counter {
  cost: number;
  expiresAt: number;
}

function filterCost(keys: string[]) {
  return keys.reduce(
    (result, key) => {
      if (PROPERTY_FILTER.test(key)) {
        result.filters += 1;
        result.properties += 1;
        result.weight += 4;
      } else if (key === 'segment' || key === 'cohort') {
        result.filters += 1;
        result.weight += 400;
      } else if (excludeShareFilterParam(key)) {
        result.filters += 1;
        result.weight += 1;
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

export function getShareQueryCost(
  query: Record<string, unknown>,
  body?: unknown,
  workMultiplier: ShareQueryWorkMultiplier = 1,
) {
  if (!Number.isSafeInteger(workMultiplier) || workMultiplier < 1 || workMultiplier > 8) {
    return null;
  }

  const topLevel = filterCost(Object.keys(query));
  const report =
    body && typeof body === 'object' && 'filters' in body
      ? (body as { filters?: unknown }).filters
      : null;
  const reportFilters = filterCost(
    report && typeof report === 'object' && !Array.isArray(report) ? Object.keys(report) : [],
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

  return Number.isSafeInteger(cost) && cost <= MAX_QUERY_COST ? { cost, charge } : null;
}

function memoryCounters(): Map<string, Counter> {
  const state = globalThis as typeof globalThis & Record<string, any>;
  state[MEMORY_COUNTERS] ??= new Map<string, Counter>();
  return state[MEMORY_COUNTERS];
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
      return { total: MAX_WINDOW_COST + 1, first: false };
    }
    counters.set(key, { cost, expiresAt: now + WINDOW_SECONDS * 1000 });
    return { total: cost, first: true };
  }

  current.cost += cost;
  return { total: current.cost, first: false };
}

export async function reserveShareQueryCost(shareId: string, cost: number) {
  const key = `share-query-budget:${hash(shareId).slice(0, 32)}`;

  if (redis.enabled) {
    try {
      await redis.client.connect(1000);
      const total = await redis.client.client.withAbortSignal(AbortSignal.timeout(1000)).eval(
        `local total = redis.call('INCRBY', KEYS[1], ARGV[1])
         if total == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
         return total`,
        { keys: [key], arguments: [String(cost), String(WINDOW_SECONDS)] },
      );
      const reserved = Number(total);
      return {
        blocked:
          !Number.isSafeInteger(reserved) ||
          reserved < cost ||
          (reserved > MAX_WINDOW_COST && reserved !== cost),
        retryAfter: WINDOW_SECONDS,
      };
    } catch {
      return { blocked: true, unavailable: true, retryAfter: WINDOW_SECONDS };
    }
  }

  const reservation = reserveLocal(key, cost);
  return {
    blocked: reservation.total > MAX_WINDOW_COST && !reservation.first,
    retryAfter: WINDOW_SECONDS,
  };
}
