import { renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_CURRENCY } from '@/lib/constants';
import { getItem } from '@/lib/storage';
import { useBoardRevenueCurrency } from './useBoardRevenueCurrency';

let shareValue: { boardId?: string } | null = null;

vi.mock('@/components/hooks/context/useShare', () => ({
  useShare: () => shareValue,
}));
vi.mock('@/lib/storage', () => ({ getItem: vi.fn() }));

beforeEach(() => {
  shareValue = null;
  vi.mocked(getItem).mockReset();
});

test('a shared board uses its configured currency rather than viewer storage', () => {
  shareValue = { boardId: 'board-1' };
  vi.mocked(getItem).mockReturnValue('EUR');

  expect(renderHook(() => useBoardRevenueCurrency('USD')).result.current).toBe('USD');
  expect(getItem).not.toHaveBeenCalled();
});

test('a shared board without a currency uses the server default instead of viewer storage', () => {
  shareValue = { boardId: 'board-1' };
  vi.mocked(getItem).mockReturnValue('EUR');

  expect(renderHook(() => useBoardRevenueCurrency()).result.current).toBe(
    process.env.defaultCurrency || DEFAULT_CURRENCY,
  );
  expect(getItem).not.toHaveBeenCalled();
});

test('an ordinary board retains the viewer currency preference', () => {
  vi.mocked(getItem).mockReturnValue('EUR');

  expect(renderHook(() => useBoardRevenueCurrency()).result.current).toBe('EUR');
  expect(getItem).toHaveBeenCalledTimes(1);
});
