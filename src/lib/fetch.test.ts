import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { httpDelete, httpGet, httpPatch, httpPost, httpPut } from './fetch';

const request = vi.fn();

beforeEach(() => {
  request.mockReset().mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', request);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each([
  ['GET', httpGet],
  ['POST', httpPost],
  ['PUT', httpPut],
  ['PATCH', httpPatch],
  ['DELETE', httpDelete],
] as const)('%s uses the browser-managed same-origin session cookie', async (method, transport) => {
  await transport('/api/me', {}, { 'x-request-id': 'synthetic-request' });

  expect(request).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    expect.objectContaining({
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-request-id': 'synthetic-request',
      },
    }),
  );
});
