import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import type { QueryFilters } from '@/lib/types';

const MAX_PAGE = 10_000;
const MAX_PAGE_SIZE = 500;
const MAX_RESULTS = 10_000;
const SAFE_ORDER_BY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function normalizePagination(filters: QueryFilters = {}) {
  const page = boundedInteger(filters.page, 1, 1, MAX_PAGE);
  const pageSize = boundedInteger(filters.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const maxResults =
    filters.maxResults === undefined
      ? undefined
      : boundedInteger(filters.maxResults, MAX_RESULTS, 1, MAX_RESULTS);
  const orderBy =
    typeof filters.orderBy === 'string' && SAFE_ORDER_BY.test(filters.orderBy)
      ? filters.orderBy
      : undefined;

  return {
    page,
    pageSize,
    maxResults,
    orderBy,
    sortDescending: filters.sortDescending === true,
  };
}
