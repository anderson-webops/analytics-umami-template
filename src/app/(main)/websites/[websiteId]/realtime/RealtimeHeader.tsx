import { useMessages, useMobile } from '@/components/hooks';
import { MetricCard } from '@/components/metrics/MetricCard';
import { MetricsBar } from '@/components/metrics/MetricsBar';
import { TrafficProvenanceNotice } from '@/components/metrics/TrafficProvenanceNotice';
import type { RealtimeData } from '@/lib/types';

export function RealtimeHeader({
  data,
}: {
  data: Pick<RealtimeData, 'totals' | 'trafficProvenance'>;
}) {
  const { t, labels } = useMessages();
  const { isPhone } = useMobile();
  const { totals } = data;

  return (
    <>
      <TrafficProvenanceNotice
        mayIncludeUnverifiedTraffic={
          data.trafficProvenance === 'may_include_unverified_public_observations'
        }
      />
      <MetricsBar
        columns={isPhone ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fit, minmax(160px, 1fr))'}
      >
        <MetricCard label={t(labels.views)} value={totals.views} />
        <MetricCard label={t(labels.visitors)} value={totals.visitors} />
        <MetricCard label={t(labels.events)} value={totals.events} />
        <MetricCard label={t(labels.countries)} value={totals.countries} />
      </MetricsBar>
    </>
  );
}
