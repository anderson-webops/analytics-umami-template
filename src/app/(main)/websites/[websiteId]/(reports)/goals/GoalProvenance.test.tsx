import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { GoalProvenanceNotice } from './GoalProvenanceNotice';

test.each([
  ['unverified_pageview', 'Pageview goal counts are unverified observations.'],
  ['backend_authorized_event', 'Event goal counts require website-backend authorization.'],
  [undefined, 'Goal count provenance is unavailable.'],
] as const)('%s goal labels its count provenance and denominator', (provenance, notice) => {
  render(<GoalProvenanceNotice numeratorProvenance={provenance} />);

  expect(screen.getByRole('note')).toHaveTextContent(notice);
  expect(screen.getByRole('note')).toHaveTextContent(
    'Total counted sessions may include unverified traffic.',
  );
});
