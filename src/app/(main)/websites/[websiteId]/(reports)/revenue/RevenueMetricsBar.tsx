import type { ReactNode } from 'react';
import { useDateRange } from '@/components/hooks';
import type { RevenueStatsData } from '@/components/hooks/queries/useRevenueStatsQuery';
import { MetricCard } from '@/components/metrics/MetricCard';
import { MetricsBar } from '@/components/metrics/MetricsBar';
import { formatLongCurrency, formatLongNumber } from '@/lib/format';

export interface RevenueMetricsBarProps {
  data: RevenueStatsData;
  currency: string;
}

interface RevenueMetricItem {
  value: number;
  label: string;
  change: number;
  formatValue: (n: number) => string;
  tooltip?: ReactNode;
}

export function RevenueMetricsBar({ data, currency }: RevenueMetricsBarProps) {
  const { isAllTime } = useDateRange();
  const { sum, count, average, unique_count, comparison } = data;
  const sumValue = Number(sum ?? 0);
  const comparisonSumValue = Number(comparison?.sum ?? 0);

  const metrics: RevenueMetricItem[] = [
    {
      value: sumValue,
      label: 'Unverified revenue claims',
      tooltip: 'Historical event claims do not prove completed orders or payments.',
      change: comparison ? sumValue - comparisonSumValue : 0,
      formatValue: (n: number) => formatLongCurrency(n, currency),
    },
    {
      value: average,
      label: 'Average claim',
      tooltip: (
        <>
          <div>Reported revenue divided by revenue-bearing events.</div>
          <div>This is not average order value.</div>
        </>
      ),
      change: comparison ? average - comparison.average : 0,
      formatValue: (n: number) => formatLongCurrency(n, currency),
    },
    {
      value: count,
      label: 'Revenue events',
      change: comparison ? count - comparison.count : 0,
      formatValue: formatLongNumber,
    },
    {
      value: unique_count,
      label: 'Sessions with claims',
      change: comparison ? unique_count - comparison.unique_count : 0,
      formatValue: formatLongNumber,
    },
  ];

  return (
    <MetricsBar>
      {metrics.map(({ label, value, change, formatValue, tooltip }) => {
        return (
          <MetricCard
            key={label}
            value={value}
            label={label}
            tooltip={tooltip}
            change={change}
            formatValue={formatValue}
            showChange={!isAllTime}
          />
        );
      })}
    </MetricsBar>
  );
}
