export function TrafficProvenanceNotice({ unverifiedViews }: { unverifiedViews?: number }) {
  if (unverifiedViews === 0) {
    return null;
  }

  return (
    <p role="note">
      {unverifiedViews === undefined
        ? 'Traffic provenance is unavailable.'
        : 'Traffic includes unverified public observations.'}{' '}
      Visitor counts do not verify people.
    </p>
  );
}
