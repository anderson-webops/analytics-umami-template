import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { collectionSchema } from './request-schema';

const website = '11111111-1111-4111-8111-111111111111';

function parse(payload: Record<string, any>, type = 'event') {
  return collectionSchema.safeParse({
    type,
    payload: {
      website,
      hostname: 'example.com',
      ...(type === 'event' && payload.data ? { name: 'purchase' } : {}),
      ...payload,
    },
  });
}

function nest(depth: number) {
  const root: Record<string, any> = {};
  let node = root;

  for (let i = 1; i < depth; i++) {
    node.a = {};
    node = node.a;
  }

  return root;
}

// Data is written after the event row, so input that would fail on write must be
// rejected up front instead of producing a 500 and a partial write.
describe('collectionSchema data', () => {
  test('accepts typical event data', () => {
    expect(
      parse({
        data: { plan: 'pro', price: 19.99, tags: ['a', 'b'], meta: { seats: 5 }, ok: true },
      }).success,
    ).toBe(true);
  });

  test('accepts five nested levels and rejects deeper data', () => {
    expect(parse({ data: nest(6) }).success).toBe(true);
    expect(parse({ data: nest(7) }).success).toBe(false);
  });

  test('rejects deep nesting inside arrays', () => {
    expect(parse({ data: { list: [nest(40)] } }).success).toBe(false);
  });

  test('rejects numbers that overflow Decimal(19,4)', () => {
    expect(parse({ data: { n: 999999999999999 } }).success).toBe(true);
    expect(parse({ data: { n: 1e15 } }).success).toBe(false);
    expect(parse({ data: { n: -1e15 } }).success).toBe(false);
    expect(parse({ data: { nested: { n: 1e20 } } }).success).toBe(false);
  });

  test('applies numeric bounds inside arrays', () => {
    expect(parse({ data: { ids: [1e20] } }).success).toBe(false);
    expect(parse({ data: { values: [42, 19.99] } }).success).toBe(true);
  });

  test('applies the same limits to identify data', () => {
    expect(parse({ data: { n: 1e15 } }, 'identify').success).toBe(false);
  });
});

describe('collectionSchema revenue', () => {
  test('accepts realistic revenue', () => {
    expect(parse({ data: { revenue: 49.99, currency: 'USD' } }).success).toBe(true);
    expect(parse({ data: { revenue: 1200.5, currency: 'EUR' } }).success).toBe(true);
  });

  test('rejects string revenue instead of interpreting an untyped claim', () => {
    expect(parse({ data: { revenue: '1200.50', currency: 'EUR' } }).success).toBe(false);
  });

  test('bounds typed revenue claims before the independently closed intake gate', () => {
    expect(parse({ data: { revenue: 1e14, currency: 'USD' } }).success).toBe(true);
    expect(parse({ data: { revenue: 1e15, currency: 'USD' } }).success).toBe(false);
    expect(parse({ data: { revenue: '1e14', currency: 'USD' } }).success).toBe(false);
  });

  test('rejects incomplete revenue pairs and identity revenue claims', () => {
    expect(parse({ data: { revenue: '1e14' } }).success).toBe(false);
    expect(parse({ data: { revenue: '1e14', currency: 'USD' } }, 'identify').success).toBe(false);
    expect(parse({ data: { currency: 'USD' } }).success).toBe(false);
    expect(parse({ data: { seats: 5 } }, 'identify').success).toBe(true);
  });
});

describe('collectionSchema hostname', () => {
  test('accepts plain, port and IDN hostnames', () => {
    expect(parse({ hostname: 'example.com' }).success).toBe(true);
    expect(parse({ hostname: 'localhost:3000' }).success).toBe(true);
    expect(parse({ hostname: 'xn--bcher-kva.de' }).success).toBe(true);
  });

  test('rejects missing website hostnames and hostnames that cannot form a URL', () => {
    expect(parse({ hostname: '' }).success).toBe(false);
    expect(parse({ hostname: undefined }).success).toBe(false);
    expect(parse({ hostname: 'bücher.de' }).success).toBe(false);
    expect(parse({ hostname: 'exa mple.com' }).success).toBe(false);
    expect(parse({ hostname: 'a:b:c' }).success).toBe(false);
  });
});

describe('collectionSchema timestamp', () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const nowSeconds = now / 1000;
  const oldest = nowSeconds - 30 * 24 * 60 * 60;
  const newest = nowSeconds + 5 * 60;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  test('accepts current unix seconds and exact collection-window boundaries', () => {
    for (const timestamp of [nowSeconds, String(nowSeconds), oldest, newest]) {
      expect(parse({ timestamp }).success, String(timestamp)).toBe(true);
    }
  });

  test('rejects old, future and nonintegral timestamps outside the collection window', () => {
    expect(parse({ timestamp: oldest - 1 }).success).toBe(false);
    expect(parse({ timestamp: newest + 1 }).success).toBe(false);
    expect(parse({ timestamp: nowSeconds + 0.5 }).success).toBe(false);
    expect(parse({ timestamp: 0 }).success).toBe(false);
    expect(parse({ timestamp: -1 }).success).toBe(false);
    expect(parse({ timestamp: 2147483648 }).success).toBe(false);
    expect(parse({ timestamp: 1e15 }).success).toBe(false);
  });
});
