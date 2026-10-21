import type { AttributionResult } from '@/queries/sql/attribution/getAttribution';

export function AttributionProvenanceNotice({
  targetProvenance,
  sourceProvenance,
}: Partial<Pick<AttributionResult, 'targetProvenance' | 'sourceProvenance'>>) {
  return (
    <p role="note">
      {targetProvenance === 'unverified_pageview'
        ? 'Path targets are unverified pageviews.'
        : targetProvenance === 'backend_authorized_event'
          ? 'Event targets require website-backend authorization.'
          : 'Target provenance is unavailable.'}{' '}
      {sourceProvenance === 'caller_reported'
        ? 'Acquisition details are caller-reported and may include unverified pageviews.'
        : 'Source provenance is unavailable.'}{' '}
      Visitor and source counts represent sessions, not verified people.
    </p>
  );
}
