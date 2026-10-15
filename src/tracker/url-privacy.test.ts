import { expect, test } from 'vitest';
import { PAID_AD_PARAMS } from '@/lib/constants';
import { sanitizeTrackingUrl } from './url-privacy';

test('retains bounded attribution while dropping unrelated queries, fragments and credentials', () => {
  const url = new URL(
    'https://user:password@example.com/page?token=private&utm_source=news&gclid=click-id#secret',
  );

  expect(sanitizeTrackingUrl(url).href).toBe(
    'https://example.com/page?utm_source=news&gclid=click-id',
  );
  expect(url.href).toContain('token=private');
});

test('rejects nested URLs, encoded delimiters and oversized attribution values', () => {
  const url = new URL(
    `https://example.com/page?utm_source=${encodeURIComponent('https://elsewhere.invalid/?key=secret')}&utm_medium=${'x'.repeat(256)}&utm_campaign=fall`,
  );

  expect(sanitizeTrackingUrl(url).href).toBe('https://example.com/page?utm_campaign=fall');
});

test('bounds aggregate attribution and removes all referrer query data', () => {
  const url = new URL(
    `https://example.com/page?utm_source=${'a'.repeat(245)}&utm_medium=${'b'.repeat(245)}&gclid=click-id&token=secret`,
  );
  const safe = sanitizeTrackingUrl(url);

  expect(safe.search.length).toBeLessThanOrEqual(501);
  expect(safe.search).not.toContain('token');
  expect(sanitizeTrackingUrl(url, false).href).toBe('https://example.com/page');
});

test('rejects URLs outside HTTP and HTTPS', () => {
  expect(() => sanitizeTrackingUrl(new URL('javascript:alert(1)'))).toThrow(
    'Unsupported tracking URL.',
  );
});

test('retains paid click identifiers used by channel reports', () => {
  const url = new URL('https://example.com/landing?dclid=click-1&epik=click-2&token=private');

  expect(sanitizeTrackingUrl(url).href).toBe(
    'https://example.com/landing?dclid=click-1&epik=click-2',
  );
});

test.each(PAID_AD_PARAMS)('preserves the paid-channel parameter %s', parameter => {
  const [key, expected] = parameter.split('=');
  const value = expected || 'click-id';
  const url = new URL('https://example.com/landing');
  url.searchParams.set(key, value);

  expect(sanitizeTrackingUrl(url).searchParams.get(key)).toBe(value);
});
