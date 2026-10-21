import { json } from '@/lib/response';

export const METRIC_PROVENANCE = {
  unverified: 'unverified_public_observations',
  backendEvent: 'backend_authorized_event_counts',
} as const;

export type MetricProvenance = (typeof METRIC_PROVENANCE)[keyof typeof METRIC_PROVENANCE];

export function getMetricProvenance(type: string): MetricProvenance {
  return type === 'event' ? METRIC_PROVENANCE.backendEvent : METRIC_PROVENANCE.unverified;
}

export function metricResponse<Row extends object>(rows: Row[], type: string) {
  const metricProvenance = getMetricProvenance(type);

  return json(
    rows.map(row => ({ ...row, metricProvenance })),
    { headers: { 'X-Metric-Provenance': metricProvenance } },
  );
}
