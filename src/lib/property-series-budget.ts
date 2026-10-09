import { getConservativeSeriesBucketCount } from '@/lib/series-budget';
import type { QueryFilters } from '@/lib/types';

export const MAX_PROPERTY_SERIES_POINTS = 10_000;
export const PROPERTY_SERIES_QUERY_TIMEOUT_MS = 10_000;
const MAX_PROPERTY_SERIES_VALUES = 50;

export function getPropertySeriesValueLimit(filters: QueryFilters): number {
  const buckets = getConservativeSeriesBucketCount({ ...filters, unit: filters.unit ?? 'day' });

  if (!buckets) {
    return 0;
  }

  return Math.min(MAX_PROPERTY_SERIES_VALUES, Math.floor(MAX_PROPERTY_SERIES_POINTS / buckets));
}
