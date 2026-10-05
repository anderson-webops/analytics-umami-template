import { expect, test } from 'vitest';
import { hasCurrentSessionGeneration } from './session-generation';

test('legacy sessions work only until the first generation rotation', () => {
  expect(hasCurrentSessionGeneration(undefined, 0)).toBe(true);
  expect(hasCurrentSessionGeneration(undefined, 1)).toBe(false);
});

test('only a matching nonnegative integer generation is accepted', () => {
  expect(hasCurrentSessionGeneration(2, 2)).toBe(true);

  for (const value of [-1, 1, 3, 2.5, '2', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(hasCurrentSessionGeneration(value, 2)).toBe(false);
  }

  expect(hasCurrentSessionGeneration(0, -1)).toBe(false);
});
