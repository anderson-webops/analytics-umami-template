import { expect, test } from 'vitest';
import { normalizePagination } from './paging';

test('normalizes bounded pagination values', () => {
  expect(
    normalizePagination({
      page: 2,
      pageSize: 100,
      maxResults: 5000,
      orderBy: 'createdAt',
      sortDescending: true,
    }),
  ).toEqual({
    page: 2,
    pageSize: 100,
    maxResults: 5000,
    orderBy: 'createdAt',
    sortDescending: true,
  });
});

test('rejects unsafe SQL identifiers and out-of-range pagination', () => {
  expect(
    normalizePagination({
      page: -1,
      pageSize: 100_000,
      maxResults: Number.NaN,
      orderBy: 'createdAt desc; drop table user',
    }),
  ).toEqual({
    page: 1,
    pageSize: 20,
    maxResults: 10_000,
    orderBy: undefined,
    sortDescending: false,
  });
});
