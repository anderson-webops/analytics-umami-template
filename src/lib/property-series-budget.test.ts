import { describe, expect, test } from 'vitest';
import { getPropertySeriesValueLimit } from './property-series-budget';

const startDate = new Date('2026-09-01T00:00:00Z');

describe('property series value budget', () => {
  test('keeps ordinary charts and reduces top values as bucket count grows', () => {
    expect(
      getPropertySeriesValueLimit({
        startDate,
        endDate: new Date('2026-09-02T00:00:00Z'),
        unit: 'day',
      }),
    ).toBe(50);
    expect(
      getPropertySeriesValueLimit({ startDate, endDate: new Date('2026-09-02T00:00:00Z') }),
    ).toBe(50);
    expect(
      getPropertySeriesValueLimit({
        startDate,
        endDate: new Date('2026-09-30T00:00:00Z'),
        unit: 'hour',
      }),
    ).toBe(14);
  });

  test('rejects missing, invalid, reversed, or oversized time dimensions', () => {
    expect(getPropertySeriesValueLimit({ startDate, endDate: startDate, unit: 'minute' })).toBe(50);
    expect(
      getPropertySeriesValueLimit({ startDate, endDate: new Date('invalid'), unit: 'day' }),
    ).toBe(0);
    expect(
      getPropertySeriesValueLimit({ startDate, endDate: new Date('2026-08-31'), unit: 'day' }),
    ).toBe(0);
    expect(
      getPropertySeriesValueLimit({ startDate, endDate: new Date('2026-09-02'), unit: 'second' }),
    ).toBe(0);
    expect(getPropertySeriesValueLimit({ startDate, unit: 'day' })).toBe(0);
    expect(
      getPropertySeriesValueLimit({
        startDate,
        endDate: new Date('2026-10-01T00:00:00Z'),
        unit: 'minute',
      }),
    ).toBe(0);
  });
});
