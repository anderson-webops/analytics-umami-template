import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { PerformanceProvenanceNotice } from './PerformanceProvenanceNotice';

test('labels browser-submitted performance measurements as unverified', () => {
  render(<PerformanceProvenanceNotice />);

  expect(screen.getByRole('note')).toHaveTextContent(
    'Browser-submitted performance measurements are unverified.',
  );
});
