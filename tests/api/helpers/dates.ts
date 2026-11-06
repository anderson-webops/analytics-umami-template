import type { SeedState } from '../seed/state';

export const TIMEZONE = 'UTC';
const QUERY_CLOCK_SKEW_ALLOWANCE_MS = 5000;

/** `startAt`/`endAt` (ms) query params spanning the whole seeded dataset. */
export function dateRange(seed: SeedState, extra: Record<string, string | number> = {}) {
  return {
    startAt: seed.range.startAt,
    endAt: Date.now() + QUERY_CLOCK_SKEW_ALLOWANCE_MS,
    ...extra,
  };
}

/** `startDate`/`endDate` ISO strings used by report parameters. */
export function dateRangeIso(seed: SeedState) {
  return {
    startDate: new Date(seed.range.startAt).toISOString(),
    endDate: new Date(Date.now() + QUERY_CLOCK_SKEW_ALLOWANCE_MS).toISOString(),
  };
}
