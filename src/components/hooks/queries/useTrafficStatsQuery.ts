import { keepPreviousData } from '@tanstack/react-query';
import { useDateParameters } from '@/components/hooks/useDateParameters';
import { useApi } from '../useApi';
import { useFilterParameters } from '../useFilterParameters';

export interface TrafficStatsData {
  pageviews: number;
  visitors: number;
  visits: number;
  comparison: {
    pageviews: number;
    visitors: number;
    visits: number;
  };
}

export function useTrafficStatsQuery(websiteId: string) {
  const { get, useQuery } = useApi();
  const { startAt, endAt } = useDateParameters();
  const filters = useFilterParameters();

  return useQuery<TrafficStatsData>({
    queryKey: ['websites:stats:traffic', { websiteId, startAt, endAt, ...filters }],
    queryFn: () => get(`/websites/${websiteId}/stats/traffic`, { startAt, endAt, ...filters }),
    enabled: !!websiteId,
    placeholderData: keepPreviousData,
  });
}
