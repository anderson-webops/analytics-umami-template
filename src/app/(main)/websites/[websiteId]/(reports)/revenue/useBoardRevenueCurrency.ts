import { useShare } from '@/components/hooks/context/useShare';
import { CURRENCY_CONFIG, DEFAULT_CURRENCY } from '@/lib/constants';
import { getItem } from '@/lib/storage';

export function useBoardRevenueCurrency(currency?: string) {
  const share = useShare();
  if (share?.boardId) {
    return currency || process.env.defaultCurrency || DEFAULT_CURRENCY;
  }
  return currency || getItem(CURRENCY_CONFIG) || process.env.defaultCurrency || DEFAULT_CURRENCY;
}
