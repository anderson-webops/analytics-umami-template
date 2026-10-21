import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { UTMProvenanceNotice } from './UTMProvenanceNotice';

test('labels UTM values and views as unverified', () => {
  render(<UTMProvenanceNotice />);

  expect(screen.getByRole('note')).toHaveTextContent(
    'UTM values are caller-reported; views are unverified.',
  );
});
