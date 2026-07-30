import { expect, test } from 'vitest';
import { excludeShareFilterParam, hasShareFilterParams } from './share-filter';

test('recognizes every supported public-share filter form', () => {
  for (const key of [
    'country',
    'country2',
    'eventType',
    'segment',
    'cohort',
    'excludeBounce',
    'match',
    'trafficType',
    'pf_plan',
  ]) {
    expect(excludeShareFilterParam(key), key).toBe(true);
  }
});

test('does not classify date ranges, paging, or report types as filters', () => {
  for (const key of ['startAt', 'endAt', 'page', 'pageSize', 'type', 'timezone']) {
    expect(excludeShareFilterParam(key), key).toBe(false);
  }
});

test('detects filters in parsed query objects', () => {
  expect(hasShareFilterParams({ startAt: 1, endAt: 2 })).toBe(false);
  expect(hasShareFilterParams({ startAt: 1, country: 'US' })).toBe(true);
});
