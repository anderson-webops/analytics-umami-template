import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { TrafficProvenanceNotice } from './TrafficProvenanceNotice';

test('labels unverified public observations without treating visitors as verified people', () => {
  render(<TrafficProvenanceNotice unverifiedViews={4} />);

  expect(screen.getByRole('note')).toHaveTextContent(
    'Traffic includes unverified public observations.',
  );
  expect(screen.getByRole('note')).toHaveTextContent('Visitor counts do not verify people.');
});

test('does not assert an unverified count when provenance is unavailable', () => {
  render(<TrafficProvenanceNotice />);

  expect(screen.getByRole('note')).toHaveTextContent('Traffic provenance is unavailable.');
});

test('does not show a warning when no public observations are counted', () => {
  const { container } = render(<TrafficProvenanceNotice unverifiedViews={0} />);

  expect(container).toBeEmptyDOMElement();
});
