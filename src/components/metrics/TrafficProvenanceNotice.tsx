export function TrafficProvenanceNotice({
  unverifiedViews,
  mayIncludeUnverifiedTraffic = false,
}: {
  unverifiedViews?: number;
  mayIncludeUnverifiedTraffic?: boolean;
}) {
  if (unverifiedViews === 0 && !mayIncludeUnverifiedTraffic) {
    return null;
  }

  return (
    <p role="note">
      {mayIncludeUnverifiedTraffic
        ? 'Traffic may include unverified public observations.'
        : unverifiedViews === undefined
          ? 'Traffic provenance is unavailable.'
          : 'Traffic includes unverified public observations.'}{' '}
      Visitor counts do not verify people.
    </p>
  );
}
