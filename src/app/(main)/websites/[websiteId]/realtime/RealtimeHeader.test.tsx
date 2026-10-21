import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { BoardRealtimeChart } from './BoardRealtimeChart';
import { BoardRealtimeMetricsBar } from './BoardRealtimeMetricsBar';
import { RealtimeHeader } from './RealtimeHeader';

vi.mock('@/components/hooks', () => ({
  useBoardRealtimeQuery: (_websiteId: string, view: 'totals' | 'series') => ({
    data:
      view === 'totals'
        ? {
            totals: { views: 3, visitors: 2, events: 1, countries: 1 },
            trafficProvenance: 'may_include_unverified_public_observations',
          }
        : {
            series: { views: [], visitors: [] },
            trafficProvenance: 'may_include_unverified_public_observations',
          },
    isLoading: false,
    error: null,
  }),
  useMessages: () => ({
    t: (value: string) => value,
    labels: { views: 'Views', visitors: 'Visitors', events: 'Events', countries: 'Countries' },
  }),
  useMobile: () => ({ isPhone: false }),
}));

vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/metrics/MetricCard', () => ({
  MetricCard: ({ label, value }: { label: string; value: number }) => (
    <div>
      {label}: {value}
    </div>
  ),
}));

vi.mock('@/components/metrics/RealtimeChart', () => ({
  RealtimeChart: () => <div>Real-time chart</div>,
}));

test('real-time header labels public observations without calling session counts verified people', () => {
  render(
    <RealtimeHeader
      data={{
        totals: { views: 3, visitors: 2, events: 1, countries: 1 },
        trafficProvenance: 'may_include_unverified_public_observations',
      }}
    />,
  );

  expect(screen.getByRole('note')).toHaveTextContent(
    'Traffic may include unverified public observations.',
  );
  expect(screen.getByRole('note')).toHaveTextContent('Visitor counts do not verify people.');
  expect(screen.getByText('Views: 3')).toBeInTheDocument();
  expect(screen.getByText('Visitors: 2')).toBeInTheDocument();
});

test('board real-time totals retain the same provenance notice', () => {
  render(<BoardRealtimeMetricsBar websiteId="website" />);

  expect(screen.getByRole('note')).toHaveTextContent(
    'Traffic may include unverified public observations.',
  );
});

test('a standalone board chart retains the same provenance notice', () => {
  render(<BoardRealtimeChart websiteId="website" />);

  expect(screen.getByRole('note')).toHaveTextContent(
    'Traffic may include unverified public observations.',
  );
  expect(screen.getByText('Real-time chart')).toBeInTheDocument();
});

test('visitor totals without pageviews remain labeled as unverified sessions', () => {
  render(
    <RealtimeHeader
      data={{
        totals: { views: 0, visitors: 2, events: 1, countries: 1 },
        trafficProvenance: 'may_include_unverified_public_observations',
      }}
    />,
  );

  expect(screen.getByRole('note')).toHaveTextContent(
    'Traffic may include unverified public observations.',
  );
  expect(screen.getByText('Visitors: 2')).toBeInTheDocument();
});
