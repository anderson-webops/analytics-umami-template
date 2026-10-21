import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { AttributionProvenanceNotice } from './AttributionProvenanceNotice';

test.each([
  ['unverified_pageview', 'Path targets are unverified pageviews.'],
  ['backend_authorized_event', 'Event targets require website-backend authorization.'],
  [undefined, 'Target provenance is unavailable.'],
] as const)('%s attribution target labels source limits', (targetProvenance, notice) => {
  render(
    <AttributionProvenanceNotice
      targetProvenance={targetProvenance}
      sourceProvenance="caller_reported"
    />,
  );

  expect(screen.getByRole('note')).toHaveTextContent(notice);
  expect(screen.getByRole('note')).toHaveTextContent(
    'Acquisition details are caller-reported and may include unverified pageviews.',
  );
  expect(screen.getByRole('note')).toHaveTextContent(
    'Visitor and source counts represent sessions, not verified people.',
  );
});

test('does not infer source provenance from an older response', () => {
  render(<AttributionProvenanceNotice targetProvenance="backend_authorized_event" />);

  expect(screen.getByRole('note')).toHaveTextContent('Source provenance is unavailable.');
});
