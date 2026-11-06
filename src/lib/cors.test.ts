import { describe, expect, test } from 'vitest';
import { corsPreflight, getApiCorsHeaders, withCorsHeaders } from './cors';

const origin = 'https://fixture.example.test';
const fixtures: { label: string; headers: HeadersInit }[] = [
  { label: 'record', headers: { 'access-control-allow-origin': origin, 'x-fixture': 'record' } },
  {
    label: 'tuple array',
    headers: [
      ['Access-Control-Allow-Origin', origin],
      ['X-Fixture', 'tuple array'],
    ],
  },
  {
    label: 'Headers instance',
    headers: new Headers({
      'Access-Control-Allow-Origin': origin,
      'X-Fixture': 'Headers instance',
    }),
  },
];

describe.each(fixtures)('CORS headers supplied as $label', ({ label, headers }) => {
  test('normalizes supported inputs and overrides defaults case-insensitively', () => {
    const result = new Headers(getApiCorsHeaders(headers));
    expect(result.get('access-control-allow-origin')).toBe(origin);
    expect(result.get('x-fixture')).toBe(label);
    expect(result.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  });

  test('preserves the response body, status and existing headers', async () => {
    const result = withCorsHeaders(
      new Response('bounded fixture', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '3' },
      }),
      headers,
    );
    expect(result.status).toBe(429);
    expect(result.statusText).toBe('Too Many Requests');
    expect(result.headers.get('retry-after')).toBe('3');
    expect(result.headers.get('access-control-allow-origin')).toBe(origin);
    expect(result.headers.get('x-fixture')).toBe(label);
    expect(await result.text()).toBe('bounded fixture');
  });

  test('preflight uses the same normalized override without duplicate origins', async () => {
    const result = corsPreflight(headers);
    expect(result.status).toBe(204);
    expect(result.headers.get('access-control-allow-origin')).toBe(origin);
    expect(result.headers.get('x-fixture')).toBe(label);
    expect(await result.text()).toBe('');
  });
});

test('the public collector defaults remain unchanged', () => {
  const result = new Headers(getApiCorsHeaders());
  expect(result.get('access-control-allow-origin')).toBe('*');
  expect(result.get('access-control-allow-headers')).toBe('Content-Type, x-umami-cache');
  expect(result.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  expect(result.get('access-control-max-age')).toBe('86400');
  expect(result.has('access-control-allow-credentials')).toBe(false);
});
