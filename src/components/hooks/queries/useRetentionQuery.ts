import type { AnalyticsParameters } from '@/lib/analytics-query';
import type { ReactQueryOptions } from '@/lib/types';
import type { RetentionParameters, RetentionResult } from '@/queries/sql/retention/getRetention';
import { useAnalyticsQuery } from './useAnalyticsQuery';

export type RetentionMetricsData = (RetentionResult & {
  trafficProvenance: 'may_include_unverified_public_observations';
})[];

export function useRetentionQuery(
  params: AnalyticsParameters & Partial<Omit<RetentionParameters, 'startDate' | 'endDate'>>,
  options?: ReactQueryOptions<RetentionMetricsData>,
) {
  return useAnalyticsQuery<RetentionMetricsData>('retention', params, options);
}
