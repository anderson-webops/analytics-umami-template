import type { AnalyticsParameters } from '@/lib/analytics-query';
import type { ReactQueryOptions } from '@/lib/types';
import type { JourneyParameters, JourneyResult } from '@/queries/sql/journeys/getJourney';
import { useAnalyticsQuery } from './useAnalyticsQuery';

export type JourneyMetricsData = (JourneyResult & {
  trafficProvenance: 'may_include_unverified_public_observations';
})[];

export function useJourneyQuery(
  params: AnalyticsParameters &
    Partial<Omit<JourneyParameters, 'startDate' | 'endDate'>> & { eventType?: number },
  options?: ReactQueryOptions<JourneyMetricsData>,
) {
  return useAnalyticsQuery<JourneyMetricsData>('journeys', params, options);
}
