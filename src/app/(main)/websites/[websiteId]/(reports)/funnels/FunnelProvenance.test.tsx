import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { FunnelResult } from '@/queries/sql/funnels/getFunnel';
import { FunnelProvenanceNotice } from './FunnelProvenanceNotice';

function step(stepSequenceProvenance: FunnelResult['stepSequenceProvenance']): FunnelResult {
  return {
    type: 'event',
    value: 'signup',
    visitors: 2,
    previous: 5,
    dropped: 3,
    dropoff: 0.6,
    remaining: 0.4,
    countUnit: 'sessions',
    stepProvenance: 'backend_authorized_event',
    stepSequenceProvenance,
  };
}

test('labels later event counts that depend on an unverified pageview', () => {
  render(<FunnelProvenanceNotice steps={[step('includes_unverified_pageview_steps')]} />);

  expect(screen.getByRole('note')).toHaveTextContent('Pageview steps are unverified observations.');
  expect(screen.getByRole('note')).toHaveTextContent(
    'Other filters may include unverified traffic.',
  );
  expect(screen.getByRole('note')).toHaveTextContent(
    'Counts represent sessions, not verified people.',
  );
});

test('qualifies authorized event steps without claiming filtered counts are verified', () => {
  render(<FunnelProvenanceNotice steps={[step('backend_authorized_event_steps_only')]} />);

  expect(screen.getByRole('note')).toHaveTextContent(
    'Event steps require website-backend authorization.',
  );
  expect(screen.getByRole('note')).toHaveTextContent(
    'Other filters may include unverified traffic.',
  );
});

test('does not claim provenance for a response from an older API', () => {
  render(<FunnelProvenanceNotice steps={[{ stepSequenceProvenance: undefined }]} />);

  expect(screen.getByRole('note')).toHaveTextContent('Funnel step provenance is unavailable.');
});

test('does not show a provenance notice before results are available', () => {
  render(<FunnelProvenanceNotice steps={[]} />);

  expect(screen.queryByRole('note')).not.toBeInTheDocument();
});
