import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { RevenueMetricsBar } from './RevenueMetricsBar';
import { RevenueTrustNotice } from './RevenueTrustNotice';

vi.mock('@/components/hooks', () => ({
  useDateRange: () => ({ isAllTime: true }),
}));

test('labels historical revenue as unverified without calling sessions users or events orders', () => {
  render(
    <>
      <RevenueTrustNotice />
      <RevenueMetricsBar
        currency="USD"
        data={{
          sum: '125.0000',
          count: 4,
          average: 31.25,
          unique_count: 3,
          arpu: null,
          revenueProvenance: 'unverified_historical_event_claims',
          comparison: {
            sum: null,
            count: 3,
            average: 30,
            unique_count: 2,
            arpu: null,
          },
        }}
      />
    </>,
  );

  expect(screen.getByRole('note')).toHaveTextContent('unverified event claims');
  expect(screen.getByText('Unverified revenue claims')).toBeInTheDocument();
  expect(screen.getByText('Revenue events')).toBeInTheDocument();
  expect(screen.getByText('Sessions with claims')).toBeInTheDocument();
  expect(screen.queryByText('Average Revenue Per User')).not.toBeInTheDocument();
  expect(screen.queryByText('Orders')).not.toBeInTheDocument();
  expect(screen.queryByText('Unique customers')).not.toBeInTheDocument();
});
