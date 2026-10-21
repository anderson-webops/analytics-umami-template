const FINANCIAL_CONTEXT = new Set([
  'billing',
  'checkout',
  'invoice',
  'order',
  'payment',
  'purchase',
  'revenue',
  'sale',
  'transaction',
]);
const FINANCIAL_AMOUNTS = new Set([
  'amount',
  'cost',
  'discount',
  'paid',
  'price',
  'shipping',
  'subtotal',
  'tax',
  'total',
  'value',
]);

function getNameTokens(value: string): string[] {
  return value
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

export function isFinancialEventName(name?: string): boolean {
  return !!name && getNameTokens(name).some(token => FINANCIAL_CONTEXT.has(token));
}

export function hasRevenueField(value: unknown, financialContext = false): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.entries(value).some(([key, child]) => {
    const tokens = getNameTokens(key);
    const nestedFinancialContext =
      financialContext || tokens.some(token => FINANCIAL_CONTEXT.has(token));

    return (
      key.toLowerCase().includes('revenue') ||
      tokens.includes('currency') ||
      (nestedFinancialContext && tokens.some(token => FINANCIAL_AMOUNTS.has(token))) ||
      (child && typeof child === 'object' && hasRevenueField(child, nestedFinancialContext))
    );
  });
}
