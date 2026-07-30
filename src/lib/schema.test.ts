import { describe, expect, test } from 'vitest';
import {
  anyObjectParam,
  queryLimitParam,
  queryOffsetParam,
  replayObjectParam,
  whiteLabelParam,
} from './schema';

describe('bounded object parameters', () => {
  test('keeps ordinary object strings tightly bounded', () => {
    expect(anyObjectParam.safeParse({ value: 'x'.repeat(20_001) }).success).toBe(false);
  });

  test('accepts a replay fragment that fits inside the record request limit', () => {
    const fragment = {
      type: 'umami:rrweb-event-fragment',
      data: {
        id: 'fragment-id',
        index: 0,
        total: 1,
        value: 'x'.repeat(500_000),
      },
    };

    expect(replayObjectParam.safeParse(fragment).success).toBe(true);
  });

  test('strips prototype-pollution property names from replay objects', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}');
    const result = replayObjectParam.safeParse(value);

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('__proto__.polluted');
  });

  test('rejects replay objects with non-finite numbers', () => {
    expect(replayObjectParam.safeParse({ value: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});

describe('white-label parameters', () => {
  test('accepts bounded HTTPS branding', () => {
    expect(
      whiteLabelParam.safeParse({
        displayName: 'Example',
        domainName: 'https://example.com',
        logoUrl: 'https://example.com/logo.svg',
      }).success,
    ).toBe(true);
  });

  test('rejects active, credentialed, or oversized branding values', () => {
    expect(
      whiteLabelParam.safeParse({
        displayName: 'Example',
        domainName: 'javascript:alert(1)',
        logoUrl: '',
      }).success,
    ).toBe(false);
    expect(
      whiteLabelParam.safeParse({
        displayName: 'Example',
        domainName: 'https://user:password@example.com',
        logoUrl: '',
      }).success,
    ).toBe(false);
    expect(
      whiteLabelParam.safeParse({
        displayName: 'x'.repeat(101),
        domainName: 'https://example.com',
        logoUrl: '',
      }).success,
    ).toBe(false);
  });
});

describe('raw-query pagination parameters', () => {
  test('accepts bounded integer limits and offsets', () => {
    expect(queryLimitParam.parse('500')).toBe(500);
    expect(queryOffsetParam.parse('0')).toBe(0);
  });

  test('rejects negative, fractional, and excessive values', () => {
    expect(queryLimitParam.safeParse('-1').success).toBe(false);
    expect(queryLimitParam.safeParse('1.5').success).toBe(false);
    expect(queryLimitParam.safeParse('501').success).toBe(false);
    expect(queryOffsetParam.safeParse('-1').success).toBe(false);
    expect(queryOffsetParam.safeParse('10001').success).toBe(false);
  });
});
