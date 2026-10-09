import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { RevenueChart } from '@/app/(main)/websites/[websiteId]/(reports)/revenue/RevenueChart';
import { PropertyChart } from '@/components/property-data/PropertyChart';
import { EventsChart } from './EventsChart';

const rows = vi.hoisted(() =>
  ['__proto__', 'constructor', 'toString', 'ordinary'].map((label, index) => ({
    x: label,
    t: '2026-10-07T00:00:00.000Z',
    y: index + 1,
    count: 1,
  })),
);
const propertyRows = vi.hoisted(() => ({ data: null as typeof rows | null }));

afterEach(() => {
  propertyRows.data = null;
});

vi.mock('@/components/hooks', () => ({
  useDateRange: () => ({
    dateRange: {
      startDate: new Date('2026-10-07T00:00:00.000Z'),
      endDate: new Date('2026-10-07T00:00:00.000Z'),
      unit: 'day',
    },
  }),
  useLocale: () => ({ locale: 'en-US', dateLocale: 'en-US' }),
  useMessages: () => ({
    t: (value: string) => value,
    labels: { revenue: 'Revenue', count: 'Count' },
  }),
  usePropertyArraySeriesQuery: () => ({ data: [], isLoading: false }),
  usePropertySeriesQuery: () => ({ data: propertyRows.data ?? rows, isLoading: false }),
  useTimezone: () => ({ timezone: 'UTC' }),
  useWebsiteEventsSeriesQuery: () => ({ data: rows, isLoading: false }),
}));

vi.mock('@/lib/date', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/date')>()),
  generateTimeSeries: (data: { x: string; y: number }[]) => data,
}));

vi.mock('@/components/charts/BarChart', () => ({
  BarChart: ({
    chartData,
  }: {
    chartData: { datasets: { label: string; data: { y: number }[] }[] };
  }) => (
    <output data-test="chart-series">
      {JSON.stringify(
        chartData.datasets.map(dataset => ({
          label: dataset.label,
          values: dataset.data.map(point => point.y),
        })),
      )}
    </output>
  ),
}));

vi.mock('@/components/charts/PieChart', () => ({
  PieChart: ({ chartData }: { chartData: { datasets: { backgroundColor: string[] }[] } }) => (
    <output data-test="chart-colors">
      {JSON.stringify(chartData.datasets[0].backgroundColor)}
    </output>
  ),
}));

vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/metrics/ListTable', () => ({
  ListTable: ({
    data,
    showPercentage,
  }: {
    data: { label: string; count: number }[];
    showPercentage: boolean;
  }) => (
    <output data-test="chart-table" data-show-percentage={String(showPercentage)}>
      {JSON.stringify(data)}
    </output>
  ),
}));

function getSeries() {
  return JSON.parse(screen.getByTestId('chart-series').textContent || '[]') as {
    label: string;
    values: number[];
  }[];
}

function expectEveryLabel(expectedRows = rows) {
  expect(getSeries()).toEqual(expectedRows.map(({ x, y }) => ({ label: x, values: [y] })));
}

test('event chart retains ordinary and reserved event names', () => {
  render(<EventsChart websiteId="website-1" />);
  expectEveryLabel();
});

test('revenue chart retains ordinary and reserved event names', () => {
  render(
    <RevenueChart
      data={rows}
      unit="day"
      minDate={new Date('2026-10-07T00:00:00.000Z')}
      maxDate={new Date('2026-10-07T00:00:00.000Z')}
      currency="USD"
    />,
  );
  expectEveryLabel();
});

test('property chart keeps reserved property values and their colors', () => {
  render(
    <PropertyChart source="event" websiteId="website-1" eventName="signup" propertyName="plan" />,
  );

  expectEveryLabel([...rows].reverse());
  expect(JSON.parse(screen.getByTestId('chart-table').textContent || '[]')).toEqual(
    rows.map(({ x, y }) => ({ label: x, count: y, percent: (100 * y) / 10 })).reverse(),
  );
  expect(JSON.parse(screen.getByTestId('chart-colors').textContent || '[]')).toEqual([
    '#2680eb',
    '#9256d9',
    '#44b556',
    '#e68619',
  ]);
  expect(screen.getByTestId('chart-table')).toHaveAttribute('data-show-percentage', 'true');
});

test('property chart does not imply full-population percentages when the value cap is reached', () => {
  propertyRows.data = Array.from({ length: 50 }, (_, index) => ({
    x: `value-${index}`,
    t: '2026-10-07T00:00:00.000Z',
    y: 1,
    count: 1,
  }));

  render(
    <PropertyChart source="event" websiteId="website-1" eventName="signup" propertyName="plan" />,
  );

  expect(screen.getByTestId('chart-table')).toHaveAttribute('data-show-percentage', 'false');
  expect(screen.queryByTestId('chart-colors')).not.toBeInTheDocument();
});
