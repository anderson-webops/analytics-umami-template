import type { FunnelResult } from '@/queries/sql/funnels/getFunnel';

export function FunnelProvenanceNotice({
  steps,
}: {
  steps: Array<Partial<Pick<FunnelResult, 'stepSequenceProvenance'>>>;
}) {
  if (steps.length === 0) {
    return null;
  }

  const known = steps.every(step => step.stepSequenceProvenance);
  const includesUnverified = steps.some(
    step => step.stepSequenceProvenance === 'includes_unverified_pageview_steps',
  );

  return (
    <p role="note">
      {known
        ? includesUnverified
          ? 'Pageview steps are unverified observations.'
          : 'Event steps require website-backend authorization.'
        : 'Funnel step provenance is unavailable.'}{' '}
      Other filters may include unverified traffic. Counts represent sessions, not verified people.
    </p>
  );
}
