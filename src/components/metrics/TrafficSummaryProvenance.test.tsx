import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { LinkMetricsBar } from '@/app/(main)/links/[linkId]/LinkMetricsBar';
import { PixelMetricsBar } from '@/app/(main)/pixels/[pixelId]/PixelMetricsBar';

vi.mock('@/components/hooks', () => ({
  useDateRange: () => ({ isAllTime: false }),
  useMessages: () => ({
    t: (value: string) => value,
    labels: {
      visitors: 'Visitors',
      visits: 'Visits',
      views: 'Views',
    },
  }),
}));

vi.mock('@/components/hooks/queries/useTrafficStatsQuery', () => ({
  useTrafficStatsQuery: () => ({
    data: {
      pageviews: 5,
      unverifiedViews: 5,
      visitors: 3,
      visits: 4,
      comparison: { pageviews: 0, visitors: 0, visits: 0 },
    },
    isLoading: false,
    isFetching: false,
  }),
}));

vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/metrics/MetricsBar', () => ({
  MetricsBar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/metrics/MetricCard', () => ({
  MetricCard: ({ label }: { label: string }) => <div>{label}</div>,
}));

test.each([
  ['link', <LinkMetricsBar key="link" linkId="link-1" />],
  ['pixel', <PixelMetricsBar key="pixel" pixelId="pixel-1" />],
])('%s summary labels public traffic as unverified', (_, summary) => {
  render(summary);

  expect(screen.getByRole('note')).toHaveTextContent(
    'Traffic includes unverified public observations.',
  );
  expect(screen.getByRole('note')).toHaveTextContent('Visitor counts do not verify people.');
});
