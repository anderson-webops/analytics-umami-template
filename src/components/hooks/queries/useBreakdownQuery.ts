import type { AnalyticsParameters } from '@/lib/analytics-query';
import type { MetricProvenance } from '@/lib/metric-provenance';
import type { ReactQueryOptions } from '@/lib/types';
import type { BreakdownData, BreakdownParameters } from '@/queries/sql/breakdown/getBreakdown';
import { useAnalyticsQuery } from './useAnalyticsQuery';

export type BreakdownMetricsData = (BreakdownData & { metricProvenance: MetricProvenance })[];

export function useBreakdownQuery(
  params: AnalyticsParameters & Partial<Omit<BreakdownParameters, 'startDate' | 'endDate'>>,
  options?: ReactQueryOptions<BreakdownMetricsData>,
) {
  return useAnalyticsQuery<BreakdownMetricsData>('breakdown', params, options);
}
