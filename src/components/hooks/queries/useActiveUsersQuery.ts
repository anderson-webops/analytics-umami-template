import type { ActiveVisitors, ReactQueryOptions } from '@/lib/types';
import { useApi } from '../useApi';

export function useActiveUsersQuery(websiteId: string, options?: ReactQueryOptions) {
  const { get, useQuery } = useApi();
  return useQuery<ActiveVisitors | null>({
    queryKey: ['websites:active', websiteId],
    queryFn: () => get(`/websites/${websiteId}/active`),
    enabled: !!websiteId,
    ...options,
  });
}
