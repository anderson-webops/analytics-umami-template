import type { GoalResult } from '@/queries/sql/goals/getGoal';

export function GoalProvenanceNotice({
  numeratorProvenance,
}: {
  numeratorProvenance?: GoalResult['numeratorProvenance'];
}) {
  return (
    <p role="note">
      {numeratorProvenance === 'unverified_pageview'
        ? 'Pageview goal counts are unverified observations.'
        : numeratorProvenance === 'backend_authorized_event'
          ? 'Event goal counts require website-backend authorization.'
          : 'Goal count provenance is unavailable.'}{' '}
      Total counted sessions may include unverified traffic.
    </p>
  );
}
