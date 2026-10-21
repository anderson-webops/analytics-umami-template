import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { PixelMetricsBar } from '../../pixels/[pixelId]/PixelMetricsBar';
import { LinkMetricsBar } from './LinkMetricsBar';

vi.mock('@/components/hooks', () => ({
  useDateRange: () => ({ isAllTime: true }),
  useMessages: () => ({
    t: (label: string) => label,
    labels: { visitors: 'visitors', visits: 'visits', views: 'views' },
  }),
}));
vi.mock('@/components/hooks/queries/useTrafficStatsQuery', () => ({
  useTrafficStatsQuery: () => ({
    data: {
      pageviews: 11,
      unverifiedViews: 7,
      visitors: 5,
      visits: 6,
      comparison: { pageviews: 9, unverifiedViews: 3, visitors: 4, visits: 5 },
    },
    isLoading: false,
    isFetching: false,
    error: null,
  }),
}));
vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/metrics/MetricsBar', () => ({
  MetricsBar: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/metrics/MetricCard', () => ({
  MetricCard: ({ label, value }: { label: string; value: number }) => (
    <div>{`${label}: ${value}`}</div>
  ),
}));

test('link and pixel summaries label unverified observations included in views', () => {
  render(
    <>
      <LinkMetricsBar linkId="link-1" />
      <PixelMetricsBar pixelId="pixel-1" />
    </>,
  );

  expect(screen.getAllByText('views: 11')).toHaveLength(2);
  expect(screen.getAllByText('Unverified views: 7')).toHaveLength(2);
});
