import { REALTIME_INTERVAL } from '@/lib/constants';
import type { RealtimeData } from '@/lib/types';
import { useApi } from '../useApi';

export function useBoardRealtimeQuery<View extends 'totals' | 'series'>(
  websiteId: string,
  view: View,
) {
  const { get, useQuery } = useApi();
  return useQuery<Pick<RealtimeData, View>>({
    queryKey: ['realtime:board', { websiteId, view }],
    queryFn: () => get(`/realtime/${websiteId}/${view}`),
    enabled: !!websiteId,
    refetchInterval: REALTIME_INTERVAL,
  });
}
