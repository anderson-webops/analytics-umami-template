import { expect, test } from 'vitest';
import { hasRevenueField, isFinancialEventName } from './revenue-provenance';

test.each([
  { revenue: 42 },
  { currency: 'USD' },
  { order: { totalRevenue: 42 } },
  { order: { URLRevenue: 42 } },
  { order: { TOTAL_REVENUE: 42 } },
  { order: { grossrevenue: 42 } },
  { order: { prerevenueEstimate: 42 } },
  { order: [{ orderCurrency: 'USD' }] },
  { 'purchase.currency': 'USD' },
  { order: { total: 42 } },
  { order: { amount: 42 } },
  { orderTotal: 42 },
  { 'payment.amount': 42 },
  { invoice: { subtotal: 42 } },
])('recognizes financial claim fields in %j', value => {
  expect(hasRevenueField(value)).toBe(true);
});

test.each([
  { concurrencyLimit: 8 },
  { concurrentUsers: 8 },
  { preferredColor: 'blue' },
  { order: { concurrencyLimit: 8 } },
  { total: 42 },
  { order: { itemCount: 3 } },
])('does not classify unrelated property fields in %j as revenue', value => {
  expect(hasRevenueField(value)).toBe(false);
});

test.each([
  'purchase',
  'orderPaid',
  'payment_succeeded',
  'invoice-created',
  'checkout',
  'grossRevenue',
])('recognizes financial event name %s', name => {
  expect(isFinancialEventName(name)).toBe(true);
  expect(hasRevenueField({ price: 42 }, isFinancialEventName(name))).toBe(true);
});

test.each(['signup', 'product_view', 'concurrency'])('preserves non-financial event %s', name => {
  expect(isFinancialEventName(name)).toBe(false);
  expect(hasRevenueField({ price: 42 }, isFinancialEventName(name))).toBe(false);
});
