import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import { MetricsExpandedTable } from './MetricsExpandedTable';

const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@umami/react-zen', () => ({
  Button: ({ children }: any) => <button type="button">{children}</button>,
  Column: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Row: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  DataColumn: () => null,
  DataTable: ({ data }: any) => (
    <ul>
      {data.map((row: any) => (
        <li key={row.label}>{row.label}</li>
      ))}
    </ul>
  ),
  SearchField: ({ value, onSearch }: any) => (
    <input
      aria-label="Search metrics"
      value={value}
      onChange={event => onSearch(event.target.value)}
    />
  ),
}));
vi.mock('@/components/hooks', () => ({
  useMessages: () => ({ t: (value: string) => value, labels: {} }),
  useWebsiteExpandedMetricsQuery: state.query,
}));
vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/common/OverlayScrollArea', () => ({
  OverlayScrollArea: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/common/Pager', () => ({
  Pager: ({ page, onPageChange }: any) => (
    <div>
      <span>Page {page}</span>
      <button type="button" onClick={() => onPageChange(page + 1)}>
        Next
      </button>
    </div>
  ),
}));
vi.mock('@/components/input/DownloadButton', () => ({ DownloadButton: () => null }));
vi.mock('@/components/metrics/MetricLabel', () => ({ MetricLabel: () => null }));

beforeEach(() => {
  state.query.mockReset().mockReturnValue({
    data: Array.from({ length: DEFAULT_PAGE_SIZE + 2 }, (_, index) => ({
      name: `/page-${index}`,
      visitors: 1,
      visits: 1,
      pageviews: 1,
      metricProvenance: 'unverified_public_observations',
    })),
  });
});

test('keeps every result reachable and resets pagination when the search changes', () => {
  render(<MetricsExpandedTable websiteId="website-1" type="path" />);
  expect(screen.getAllByRole('listitem')).toHaveLength(DEFAULT_PAGE_SIZE);
  expect(screen.getByText('/page-0')).toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent('Unverified public observations');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Page 2')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText(`/page-${DEFAULT_PAGE_SIZE}`)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search metrics' }), {
    target: { value: 'new' },
  });
  expect(screen.getByText('Page 1')).toBeInTheDocument();
  expect(state.query).toHaveBeenLastCalledWith(
    'website-1',
    expect.objectContaining({ type: 'path', search: 'new' }),
  );
});

test('changing the metric type returns to its first page', () => {
  const view = render(<MetricsExpandedTable websiteId="website-1" type="path" />);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Page 2')).toBeInTheDocument();
  view.rerender(<MetricsExpandedTable websiteId="website-1" type="event" />);
  expect(screen.getByText('Page 1')).toBeInTheDocument();
});
