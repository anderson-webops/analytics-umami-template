import { keepPreviousData } from '@tanstack/react-query';
import { useDateParameters } from '@/components/hooks/useDateParameters';
import { useApi } from '../useApi';
import { useFilterParameters } from '../useFilterParameters';

interface RevenueTotalData {
  sum: number;
}

export function useRevenueTotalQuery({
  websiteId,
  currency,
}: {
  websiteId: string;
  currency: string;
}) {
  const { get, useQuery } = useApi();
  const { startAt, endAt } = useDateParameters();
  const filters = useFilterParameters({ includePagination: false });

  return useQuery<RevenueTotalData>({
    queryKey: ['websites:revenue:total', { websiteId, currency, startAt, endAt, ...filters }],
    queryFn: () =>
      get(`/websites/${websiteId}/revenue/total`, {
        currency,
        startAt,
        endAt,
        ...filters,
      }),
    enabled: !!(websiteId && currency),
    placeholderData: keepPreviousData,
  });
}
