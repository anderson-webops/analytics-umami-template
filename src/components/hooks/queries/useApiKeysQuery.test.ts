import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { API_KEY_PAGE_SIZE } from '@/lib/api-key-limits';
import { useApiKeysQuery } from './useApiKeysQuery';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  query: vi.fn(options => options),
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: mocks.query,
}));
vi.mock('../useApi', () => ({
  useApi: () => ({ get: mocks.get }),
}));
vi.mock('../useModified', () => ({
  useModified: () => ({ modified: 1 }),
}));

test('loads the next bounded API-key page from the last visible key', async () => {
  renderHook(() => useApiKeysQuery());
  const options = mocks.query.mock.lastCall[0];
  const page = Array.from({ length: API_KEY_PAGE_SIZE }, (_, index) => ({
    id: `key-${index}`,
  }));

  await options.queryFn({ pageParam: null });
  expect(mocks.get).toHaveBeenLastCalledWith('/me/api-keys', {});
  expect(options.getNextPageParam(page)).toBe('key-49');

  await options.queryFn({ pageParam: 'key-49' });
  expect(mocks.get).toHaveBeenLastCalledWith('/me/api-keys', { cursor: 'key-49' });
  expect(options.getNextPageParam(page.slice(0, -1))).toBeUndefined();
});
