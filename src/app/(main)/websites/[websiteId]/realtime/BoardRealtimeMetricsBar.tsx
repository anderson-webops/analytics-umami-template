import { LoadingPanel } from '@/components/common/LoadingPanel';
import { useBoardRealtimeQuery } from '@/components/hooks';
import { RealtimeHeader } from './RealtimeHeader';

export function BoardRealtimeMetricsBar({ websiteId }: { websiteId: string }) {
  const { data, isLoading, error } = useBoardRealtimeQuery(websiteId, 'totals');

  return (
    <LoadingPanel data={data} isLoading={isLoading} error={error} minHeight="136px">
      <RealtimeHeader data={data} />
    </LoadingPanel>
  );
}
