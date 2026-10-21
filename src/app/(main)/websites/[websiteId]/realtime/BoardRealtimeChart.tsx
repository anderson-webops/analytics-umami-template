import { LoadingPanel } from '@/components/common/LoadingPanel';
import { useBoardRealtimeQuery } from '@/components/hooks';
import { RealtimeChart } from '@/components/metrics/RealtimeChart';
import { TrafficProvenanceNotice } from '@/components/metrics/TrafficProvenanceNotice';

export function BoardRealtimeChart({ websiteId }: { websiteId: string }) {
  const { data, isLoading, error } = useBoardRealtimeQuery(websiteId, 'series');

  return (
    <LoadingPanel data={data} isLoading={isLoading} error={error} minHeight="320px">
      <TrafficProvenanceNotice
        mayIncludeUnverifiedTraffic={
          data?.trafficProvenance === 'may_include_unverified_public_observations'
        }
      />
      <RealtimeChart data={data} unit="minute" />
    </LoadingPanel>
  );
}
