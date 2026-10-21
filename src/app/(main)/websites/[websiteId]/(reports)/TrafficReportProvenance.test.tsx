import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { Breakdown } from './breakdown/Breakdown';
import { Retention } from './retention/Retention';

const startDate = new Date('2026-10-01T00:00:00.000Z');
const endDate = new Date('2026-10-02T00:00:00.000Z');

vi.mock('@umami/react-zen', async importOriginal => {
  const actual = await importOriginal<typeof import('@umami/react-zen')>();
  return { ...actual, DataTable: () => null, DataColumn: () => null };
});
vi.mock('@/components/common/Panel', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/hooks', () => ({
  useBreakdownQuery: () => ({
    data: [
      {
        path: '/claimed',
        views: 4,
        visitors: 3,
        visits: 3,
        bounces: 1,
        totaltime: 20,
        metricProvenance: 'unverified_public_observations',
      },
    ],
    isLoading: false,
  }),
  useRetentionQuery: () => ({
    data: [
      {
        date: '2026-10-01',
        day: 0,
        visitors: 3,
        returnVisitors: 3,
        percentage: 100,
        trafficProvenance: 'may_include_unverified_public_observations',
      },
    ],
    isLoading: false,
  }),
  useFields: () => ({ fields: [] }),
  useFormat: () => ({ formatValue: (value: string) => value }),
  useLocale: () => ({ locale: 'en-US' }),
  useMessages: () => ({ t: (value: string) => value, labels: { cohort: 'Cohort', day: 'Day' } }),
}));

test('breakdown warns that public traffic and visitor counts are not verified', () => {
  render(
    <Breakdown
      websiteId="website-1"
      startDate={startDate}
      endDate={endDate}
      selectedFields={['path']}
    />,
  );

  expect(screen.getByRole('note')).toHaveTextContent('unverified public observations');
  expect(screen.getByRole('note')).toHaveTextContent('Visitor counts do not verify people.');
});

test('retention warns that public activity may affect cohorts', () => {
  render(<Retention websiteId="website-1" startDate={startDate} endDate={endDate} days={[1]} />);

  expect(screen.getByRole('note')).toHaveTextContent('may include unverified public observations');
  expect(screen.getByRole('note')).toHaveTextContent('Visitor counts do not verify people.');
});
