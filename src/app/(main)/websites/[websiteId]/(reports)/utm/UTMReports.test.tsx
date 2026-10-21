import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BoardUTM } from './BoardUTM';
import { UTM } from './UTM';

const startDate = new Date('2026-10-01T00:00:00.000Z');
const endDate = new Date('2026-10-02T00:00:00.000Z');

vi.mock('@/components/charts/PieChart', () => ({ PieChart: () => null }));
vi.mock('@/components/metrics/ListTable', () => ({ ListTable: () => null }));
vi.mock('@/components/hooks', () => ({
  useDateRange: () => ({ dateRange: { startDate, endDate } }),
  useMessages: () => ({ t: (value: string) => value, labels: { views: 'Views' } }),
  useUTMMetricsQuery: () => ({
    data: [{ utm: 'claimed-source', views: 4, metricProvenance: 'unverified_public_observations' }],
    isLoading: false,
  }),
}));

test('UTM report shows one provenance notice across all dimensions', () => {
  render(<UTM websiteId="website-1" startDate={startDate} endDate={endDate} />);

  expect(screen.getAllByRole('note')).toHaveLength(1);
  expect(screen.getByRole('note')).toHaveTextContent('views are unverified');
});

test('board UTM report labels displayed metrics', () => {
  render(<BoardUTM websiteId="website-1" />);

  expect(screen.getAllByRole('note')).toHaveLength(1);
  expect(screen.getByRole('note')).toHaveTextContent('UTM values are caller-reported');
});
