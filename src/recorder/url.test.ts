import { expect, test } from 'vitest';
import { getReplaySafeUrl, redactReplayNavigationEvents } from './url';

test.each([
  ['https://example.com/private?reset=secret#fragment', 'https://example.com/private'],
  ['http://localhost:3000/search?q=private#result', 'http://localhost:3000/search'],
  ['https://user:password@example.com/account?token=secret', 'https://example.com/account'],
  ['/path?invite=secret#fragment', '/path'],
  ['javascript:alert(1)', '/'],
  ['//example.com/path?token=secret', '/'],
  ['not-a-url?token=secret', '/'],
])('redacts navigation URL %s', (input, expected) => {
  expect(getReplaySafeUrl(input)).toBe(expected);
});

test('redacts replay metadata and navigation events without changing other data', () => {
  const events = [
    {
      type: 4,
      timestamp: 1,
      data: { href: 'https://example.com/page?reset=secret#fragment', width: 800, height: 600 },
    },
    {
      type: 5,
      timestamp: 2,
      data: { tag: 'url-change', payload: { url: 'https://example.com/next?code=secret' } },
    },
    { type: 5, timestamp: 3, data: { tag: 'scroll-progress', payload: { scrollPct: 50 } } },
  ];

  const sanitized = redactReplayNavigationEvents(events);

  expect(sanitized[0].data).toEqual({
    href: 'https://example.com/page',
    width: 800,
    height: 600,
  });
  expect(sanitized[1].data.payload.url).toBe('https://example.com/next');
  expect(sanitized[2]).toBe(events[2]);
  expect(events[0].data.href).toContain('reset=secret');
  expect(JSON.stringify(sanitized)).not.toContain('secret');
});
