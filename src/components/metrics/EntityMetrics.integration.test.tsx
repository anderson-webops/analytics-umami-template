import { render, screen } from '@testing-library/react';
import { cloneElement } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { LinkMetricsBar } from '@/app/(main)/links/[linkId]/LinkMetricsBar';
import { PixelMetricsBar } from '@/app/(main)/pixels/[pixelId]/PixelMetricsBar';
import { RevenueMetricsBar } from '@/app/(main)/websites/[websiteId]/(reports)/revenue/RevenueMetricsBar';

const state = vi.hoisted(() => ({
  dateRange: vi.fn(),
  traffic: vi.fn(),
  cards: [] as any[],
  range: { isAllTime: false, hasComparison: true },
}));
vi.mock('@/components/hooks', () => ({
  useDateRange: state.dateRange,
  useTimezone: () => ({ timezone: 'America/New_York' }),
  useMessages: () => ({
    t: (value: string) => value,
    labels: { visitors: 'Visitors', visits: 'Visits', views: 'Views' },
  }),
}));
vi.mock('@/components/hooks/queries/useTrafficStatsQuery', () => ({
  useTrafficStatsQuery: state.traffic,
}));
vi.mock('@/components/metrics/MetricCard', () => ({
  MetricCard: (props: any) => {
    state.cards.push(props);
    return (
      <span data-testid="metric-card" data-change={String(props.showChange)}>
        {props.label}
      </span>
    );
  },
}));
vi.mock('@/components/metrics/MetricsBar', () => ({
  MetricsBar: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/metrics/TrafficProvenanceNotice', () => ({
  TrafficProvenanceNotice: ({ unverifiedViews }: any) => <p>Unverified views: {unverifiedViews}</p>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.cards = [];
  state.range = { isAllTime: false, hasComparison: true };
  state.dateRange.mockImplementation(() => state.range);
  state.traffic.mockReturnValue({
    data: {
      visitors: 10,
      visits: 20,
      pageviews: 30,
      unverifiedViews: 25,
      comparison: { visitors: 5, visits: 12, pageviews: 20 },
    },
  });
});

test.each([
  ['link', <LinkMetricsBar key="link" linkId="entity-1" />],
  ['pixel', <PixelMetricsBar key="pixel" pixelId="entity-1" />],
])(
  '%s metrics keep specialized traffic data and timezone-aware comparisons',
  (_name, component) => {
    const view = render(component);
    expect(state.traffic).toHaveBeenCalledWith('entity-1');
    expect(state.dateRange).toHaveBeenCalledWith({ timezone: 'America/New_York' });
    expect(screen.getByText('Unverified views: 25')).toBeInTheDocument();
    expect(state.cards.map(card => card.change)).toEqual([5, 8, 10]);
    expect(state.cards.every(card => card.showChange)).toBe(true);
    state.range = { isAllTime: false, hasComparison: false };
    state.cards = [];
    view.rerender(cloneElement(component));
    expect(state.cards).toHaveLength(3);
    expect(state.cards.every(card => !card.showChange)).toBe(true);
  },
);

test('historical revenue comparisons preserve unverified claim semantics and numeric arithmetic', () => {
  const component = (
    <RevenueMetricsBar
      currency="USD"
      data={{
        sum: '125.0000',
        count: 4,
        average: 31.25,
        unique_count: 3,
        arpu: null,
        revenueProvenance: 'unverified_historical_event_claims',
        comparison: { sum: '25.0000', count: 2, average: 12.5, unique_count: 2, arpu: null },
      }}
    />
  );
  const view = render(component);
  expect(state.dateRange).toHaveBeenCalledWith({ timezone: 'America/New_York' });
  expect(state.cards[0]).toMatchObject({
    value: 125,
    change: 100,
    label: 'Unverified revenue claims',
  });
  expect(screen.queryByText('Average Revenue Per User')).not.toBeInTheDocument();
  expect(state.cards.every(card => card.showChange)).toBe(true);
  state.range = { isAllTime: true, hasComparison: true };
  state.cards = [];
  view.rerender(cloneElement(component));
  expect(state.cards).toHaveLength(4);
  expect(state.cards.every(card => !card.showChange)).toBe(true);
});
