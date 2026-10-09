import { LoadingPanel } from '@/components/common/LoadingPanel';
import { useBoardRealtimeQuery } from '@/components/hooks';
import { RealtimeChart } from '@/components/metrics/RealtimeChart';

export function BoardRealtimeChart({ websiteId }: { websiteId: string }) {
  const { data, isLoading, error } = useBoardRealtimeQuery(websiteId, 'series');

  return (
    <LoadingPanel data={data} isLoading={isLoading} error={error} minHeight="320px">
      <RealtimeChart data={data} unit="minute" />
    </LoadingPanel>
  );
}
