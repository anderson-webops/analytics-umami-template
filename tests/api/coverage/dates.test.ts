import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dateRange, dateRangeIso } from '../helpers/dates';
import type { SeedState } from '../seed/state';

const seed = { range: { startAt: 1000 } } as SeedState;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

test('the query window includes a bounded five-second server clock allowance', () => {
  expect(dateRange(seed)).toEqual({ startAt: 1000, endAt: Date.now() + 5000 });
  expect(dateRange(seed, { endAt: 2000, eventName: 'purchase' })).toEqual({
    startAt: 1000,
    endAt: 2000,
    eventName: 'purchase',
  });
});

test('report dates use the same bounded clock allowance', () => {
  expect(dateRangeIso(seed)).toEqual({
    startDate: new Date(1000).toISOString(),
    endDate: new Date(Date.now() + 5000).toISOString(),
  });
});
