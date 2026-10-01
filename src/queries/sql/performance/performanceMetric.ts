const PERFORMANCE_METRICS = new Set(['lcp', 'inp', 'cls', 'fcp', 'ttfb']);

export function getPerformanceMetricColumn(metric: unknown): string {
  if (metric === undefined) {
    return 'lcp';
  }

  if (typeof metric !== 'string' || !PERFORMANCE_METRICS.has(metric)) {
    throw new Error('INVALID_PERFORMANCE_METRIC');
  }

  return metric;
}
