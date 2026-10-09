import { describe, expect, test } from 'vitest';
import { getAllowedTrackingOrigin } from './tracking-origin';

describe('tracking browser origin', () => {
  test.each(['https://example.com', 'https://www.example.com', 'http://example.com'])(
    'allows an exact configured hostname: %s',
    origin => {
      expect(getAllowedTrackingOrigin(origin, 'example.com')).toBe(origin);
    },
  );

  test.each([
    'null',
    'https://example.com.evil.test',
    'https://evil.test',
    'http://example.com:3000',
    'https://example.com:444',
    'https://user@example.com',
    'https://example.com/path',
    'https://example.com/',
    'https://example.com, https://evil.test',
    'file:///page',
    'data:text/html,hello',
  ])('rejects an unrelated or non-origin value: %s', origin => {
    expect(getAllowedTrackingOrigin(origin, 'example.com')).toBeNull();
  });

  test('does not invent an origin for non-browser callers', () => {
    expect(getAllowedTrackingOrigin(null, 'example.com')).toBeNull();
  });

  test('permits only the configured localhost port', () => {
    expect(getAllowedTrackingOrigin('http://localhost:3000', 'localhost:3000')).toBe(
      'http://localhost:3000',
    );
    expect(getAllowedTrackingOrigin('http://localhost:3001', 'localhost:3000')).toBeNull();
  });
});
