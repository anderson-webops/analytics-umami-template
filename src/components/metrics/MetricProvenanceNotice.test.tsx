import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { MetricProvenanceNotice } from './MetricProvenanceNotice';

test.each([
  ['unverified_public_observations', 'Unverified public observations'],
  ['backend_authorized_event_counts', 'website-backend authorization'],
  [undefined, 'Metric provenance is unavailable'],
] as const)('labels %s without claiming verified visitors', (metricProvenance, notice) => {
  render(<MetricProvenanceNotice metricProvenance={metricProvenance} />);

  expect(screen.getByRole('note')).toHaveTextContent(notice);
  expect(screen.getByRole('note')).toHaveTextContent('not verified people');
});
