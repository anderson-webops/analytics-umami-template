import { useInfiniteQuery } from '@tanstack/react-query';
import { API_KEY_PAGE_SIZE } from '@/lib/api-key-limits';
import { useApi } from '../useApi';
import { useModified } from '../useModified';

export interface ApiKeyData {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export function useApiKeysQuery() {
  const { get } = useApi();
  const { modified } = useModified('api-keys');

  return useInfiniteQuery<
    ApiKeyData[],
    Error,
    { pages: ApiKeyData[][] },
    (string | object)[],
    string | null
  >({
    queryKey: ['api-keys', { modified }],
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      get('/me/api-keys', pageParam ? { cursor: pageParam } : {}) as Promise<ApiKeyData[]>,
    getNextPageParam: lastPage =>
      lastPage.length === API_KEY_PAGE_SIZE ? lastPage[lastPage.length - 1].id : undefined,
  });
}
