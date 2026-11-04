import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ListTable } from './ListTable';

vi.mock('@umami/react-zen', () => ({
  Column: ({ children }) => <div>{children}</div>,
  Grid: ({ children }) => <div>{children}</div>,
  Row: ({ children }) => <div>{children}</div>,
  Text: ({ children }) => <span>{children}</span>,
}));

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({ t: value => value, labels: { unknown: 'Unknown' } }),
  useMobile: () => ({ isPhone: false }),
}));

vi.mock('react-window', () => ({
  List: ({ rowComponent: RowComponent, rowProps }) => (
    <RowComponent index={0} style={{}} {...rowProps} />
  ),
}));

vi.mock('@/components/common/AnimatedDiv', () => ({
  AnimatedDiv: ({ title, children }) => <span title={title}>{children.get()}</span>,
}));

test('virtual rows retain their identity and editable state when data refreshes', () => {
  const renderLabel = row => <input aria-label="row label" defaultValue={row.label} />;
  const { rerender } = render(
    <ListTable
      data={[{ label: 'alpha', count: 10, percent: 100 }]}
      virtualize
      animate={false}
      renderLabel={renderLabel}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'row label' });
  fireEvent.change(input, { target: { value: 'retained edit' } });

  rerender(
    <ListTable
      data={[{ label: 'alpha', count: 20, percent: 100 }]}
      virtualize
      animate={false}
      renderLabel={renderLabel}
    />,
  );

  expect(screen.getByRole('textbox', { name: 'row label' })).toBe(input);
  expect(input).toHaveValue('retained edit');
  expect(screen.getByTitle('20')).toBeInTheDocument();
});

test('nonvirtual rows retain labels, counts and custom change content', () => {
  render(
    <ListTable
      data={[{ label: 'alpha', count: 10, percent: 100 }]}
      animate={false}
      showPercentage={false}
      renderChange={() => <span>increase</span>}
    />,
  );
  expect(screen.getByText('alpha')).toBeInTheDocument();
  expect(screen.getByTitle('10')).toBeInTheDocument();
  expect(screen.getByText('increase')).toBeInTheDocument();
});
