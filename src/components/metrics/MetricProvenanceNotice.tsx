import type { MetricProvenance } from '@/lib/metric-provenance';

export function MetricProvenanceNotice({
  metricProvenance,
}: {
  metricProvenance?: MetricProvenance;
}) {
  return (
    <p role="note">
      {metricProvenance === 'unverified_public_observations'
        ? 'Unverified public observations.'
        : metricProvenance === 'backend_authorized_event_counts'
          ? 'Event counts require website-backend authorization; filters may include unverified traffic.'
          : 'Metric provenance is unavailable.'}{' '}
      Visitor counts are not verified people.
    </p>
  );
}
