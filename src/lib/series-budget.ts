import type { QueryFilters } from '@/lib/types';

const MIN_BUCKET_DURATION_MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 23 * 3_600_000,
  month: 27 * 24 * 3_600_000,
  year: 364 * 24 * 3_600_000,
};

export function getConservativeSeriesBucketCount(filters: QueryFilters): number {
  const { startDate, endDate, unit } = filters;
  const bucketDuration = MIN_BUCKET_DURATION_MS[unit as keyof typeof MIN_BUCKET_DURATION_MS];
  const duration = startDate && endDate ? endDate.getTime() - startDate.getTime() : NaN;

  if (!bucketDuration || !Number.isFinite(duration) || duration < 0) {
    return 0;
  }

  return Math.ceil(duration / bucketDuration) + 2;
}
