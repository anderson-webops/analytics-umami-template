import type { AnalyticsParameters } from '@/lib/analytics-query';
import type { MetricProvenance } from '@/lib/metric-provenance';
import type { ReactQueryOptions } from '@/lib/types';
import { useAnalyticsQuery } from './useAnalyticsQuery';
export type UTMMetricsData = { utm: string; views: number; metricProvenance: MetricProvenance }[];
export function useUTMMetricsQuery(
  params: AnalyticsParameters & { type: string; limit?: number },
  options?: ReactQueryOptions<UTMMetricsData>,
) {
  return useAnalyticsQuery<UTMMetricsData>('utm/metrics', params, options);
}
