import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FilterLink } from './FilterLink';

vi.mock('@/components/hooks', () => ({
  useConfig: () => ({}),
  useMessages: () => ({ t: (value: string) => value, labels: { unknown: 'Unknown' } }),
  useNavigation: () => ({ query: {}, updateParams: () => '/' }),
}));
test('empty values retain the default unknown-value wrapper', () => {
  render(<FilterLink type="path" value="" />);
  expect(screen.getByText('(Unknown)')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
test('callers can display an empty-value label without the wrapper', () => {
  render(<FilterLink type="referrer" value="" label="Direct" wrapEmptyLabel={false} />);
  expect(screen.getByText('Direct')).toBeInTheDocument();
  expect(screen.queryByText('(Direct)')).not.toBeInTheDocument();
});
