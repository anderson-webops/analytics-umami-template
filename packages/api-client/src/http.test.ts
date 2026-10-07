import { describe, expect, test } from 'vitest';
import { UmamiApiError } from './errors';
import type { OperationDefinition } from './generated/operations';
import {
  buildAuthHeaders,
  buildPath,
  buildUrl,
  sendRequest,
  splitInput,
  stripApiPrefix,
} from './http';

const statsOperation: OperationDefinition = {
  operationId: 'getWebsiteStats',
  method: 'get',
  path: '/api/websites/{websiteId}/stats',
  pathParams: ['websiteId'],
  queryParams: ['startAt', 'endAt', 'browser'],
  hasBody: false,
};

const funnelOperation: OperationDefinition = {
  operationId: 'createWebsiteFunnel',
  method: 'post',
  path: '/api/websites/{websiteId}/funnels',
  pathParams: ['websiteId'],
  queryParams: [],
  hasBody: true,
};

describe('buildPath', () => {
  test('encodes path parameters', () => {
    expect(buildPath('/api/websites/{websiteId}/stats', { websiteId: 'a b/c' })).toBe(
      '/api/websites/a%20b%2Fc/stats',
    );
  });

  test('throws on a missing path parameter', () => {
    expect(() => buildPath('/api/websites/{websiteId}', {})).toThrow(/websiteId/);
  });
});

describe('buildUrl', () => {
  test('strips the /api prefix and joins with the base URL', () => {
    expect(stripApiPrefix('/api/websites')).toBe('/websites');
    expect(buildUrl('https://api.umami.is/v1/', '/api/websites', {}).toString()).toBe(
      'https://api.umami.is/v1/websites',
    );
    expect(buildUrl('https://example.com/api', '/api/websites', {}).toString()).toBe(
      'https://example.com/api/websites',
    );
  });

  test('serializes query values, arrays and dates and skips nullish values', () => {
    const url = buildUrl('https://example.com/api', '/api/websites', {
      page: 2,
      search: 'a b',
      skip: undefined,
      nothing: null,
      flag: true,
      tags: ['x', 'y'],
      when: new Date('2024-01-02T03:04:05.000Z'),
    });

    expect(url.searchParams.getAll('tags')).toEqual(['x', 'y']);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('search')).toBe('a b');
    expect(url.searchParams.get('flag')).toBe('true');
    expect(url.searchParams.get('when')).toBe('2024-01-02T03:04:05.000Z');
    expect(url.searchParams.has('skip')).toBe(false);
    expect(url.searchParams.has('nothing')).toBe(false);
  });
});

describe('buildAuthHeaders', () => {
  test('uses bearer authentication for tokens', () => {
    expect(buildAuthHeaders({ token: 'abc' })).toEqual({ authorization: 'Bearer abc' });
  });

  test('sends API keys as both header conventions when no token is present', () => {
    expect(buildAuthHeaders({ apiKey: 'umami_123' })).toEqual({
      'x-umami-api-key': 'umami_123',
      authorization: 'Bearer umami_123',
    });
  });

  test('prefers the explicit token as bearer when both are present', () => {
    expect(buildAuthHeaders({ apiKey: 'k', token: 't' })).toEqual({
      'x-umami-api-key': 'k',
      authorization: 'Bearer t',
    });
  });
});

describe('splitInput', () => {
  test('routes known keys to path/query and unknown keys to query for GET', () => {
    expect(
      splitInput(statsOperation, {
        websiteId: 'w',
        startAt: 1,
        endAt: 2,
        browser1: 'chrome',
        pf_plan: 'pro',
      }),
    ).toEqual({
      path: { websiteId: 'w' },
      query: { startAt: 1, endAt: 2, browser1: 'chrome', pf_plan: 'pro' },
      body: undefined,
    });
  });

  test('routes unknown keys to the body and keeps path params out of it', () => {
    expect(
      splitInput(funnelOperation, {
        websiteId: 'w',
        name: 'Signup',
        parameters: { steps: [] },
      }),
    ).toEqual({
      path: { websiteId: 'w' },
      query: {},
      body: { name: 'Signup', parameters: { steps: [] } },
    });
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('sendRequest', () => {
  test('sends JSON bodies and merges headers', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      captured = { url: url.toString(), init };
      return jsonResponse({ ok: true });
    };

    const result = await sendRequest(fetchImpl, {
      method: 'post',
      url: new URL('https://example.com/api/websites/w/funnels'),
      headers: { authorization: 'Bearer t', 'x-custom': '1' },
      body: { websiteId: 'w' },
    });

    expect(result).toEqual({ ok: true });
    expect(captured?.init?.method).toBe('POST');
    expect(captured?.init?.redirect).toBe('error');
    expect(captured?.init?.body).toBe(JSON.stringify({ websiteId: 'w' }));
    expect(captured?.init?.headers).toMatchObject({
      authorization: 'Bearer t',
      'x-custom': '1',
      'content-type': 'application/json',
      accept: 'application/json',
    });
  });

  test.each([
    'http://analytics.example.com/api',
    'http://192.168.1.10/api',
    'http://127.0.0.1.evil.example/api',
    'http://127.0.0.1@evil.example/api',
    'ftp://analytics.example.com/api',
    'https://user:password@analytics.example.com/api',
    'https://analytics.example.com/api#fragment',
  ])('rejects an unsafe API destination before sending credentials: %s', async value => {
    let called = false;

    await expect(
      sendRequest(
        async () => {
          called = true;
          return jsonResponse({ ok: true });
        },
        {
          method: 'get',
          url: new URL(value),
          headers: { authorization: 'Bearer synthetic-token', 'x-umami-api-key': 'synthetic-key' },
        },
      ),
    ).rejects.toThrow(/HTTPS or local loopback HTTP/);
    expect(called).toBe(false);
  });

  test.each([
    'https://analytics.example.com/api',
    'http://localhost:3000/api',
    'http://127.0.0.1:3000/api',
    'http://[::1]:3000/api',
    'http://127.1:3000/api',
  ])('allows a secure or local API destination: %s', async value => {
    await expect(
      sendRequest(async () => jsonResponse({ ok: true }), {
        method: 'get',
        url: new URL(value),
        headers: { authorization: 'Bearer synthetic-token' },
      }),
    ).resolves.toEqual({ ok: true });
  });

  test('throws UmamiApiError with the API error code for 4xx responses', async () => {
    const fetchImpl = async () =>
      jsonResponse(
        { error: { message: 'Nope', code: 'unauthorized', status: 401 } },
        { status: 401 },
      );

    await expect(
      sendRequest(fetchImpl, {
        method: 'get',
        url: new URL('https://example.com/api/websites'),
        headers: {},
      }),
    ).rejects.toMatchObject({
      name: 'UmamiApiError',
      status: 401,
      code: 'unauthorized',
      message: 'Nope',
      isUnauthorized: true,
    });
  });

  test('throws UmamiApiError for 5xx responses without a JSON body', async () => {
    const fetchImpl = async () => new Response('boom', { status: 502 });

    const error = (await sendRequest(fetchImpl, {
      method: 'get',
      url: new URL('https://example.com/api/websites'),
      headers: {},
    }).catch(e => e)) as UmamiApiError;

    expect(error).toBeInstanceOf(UmamiApiError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('server-error');
    expect(error.isServerError).toBe(true);
  });

  test('throws on malformed JSON in successful responses', async () => {
    const fetchImpl = async () =>
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } });

    await expect(
      sendRequest(fetchImpl, {
        method: 'get',
        url: new URL('https://example.com/api/websites'),
        headers: {},
      }),
    ).rejects.toMatchObject({ code: 'invalid-json' });
  });

  test('returns undefined for empty bodies', async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });

    await expect(
      sendRequest(fetchImpl, {
        method: 'delete',
        url: new URL('https://example.com/api/websites/w'),
        headers: {},
      }),
    ).resolves.toBeUndefined();
  });

  test('accepts a response at the byte limit', async () => {
    const body = '{"ok":true}';

    await expect(
      sendRequest(
        async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
        {
          method: 'get',
          url: new URL('https://example.com/api/websites'),
          headers: {},
          maxResponseBytes: new TextEncoder().encode(body).byteLength,
        },
      ),
    ).resolves.toEqual({ ok: true });
  });

  test('rejects an oversized Content-Length before reading the body', async () => {
    const stream = new ReadableStream<Uint8Array>({});

    await expect(
      sendRequest(async () => new Response(stream, { headers: { 'content-length': '100' } }), {
        method: 'get',
        url: new URL('https://example.com/api/websites'),
        headers: {},
        maxResponseBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  test('rejects chunked responses that exceed the byte limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abcd'));
        controller.enqueue(new TextEncoder().encode('ef'));
        controller.close();
      },
    });

    await expect(
      sendRequest(async () => new Response(stream), {
        method: 'get',
        url: new URL('https://example.com/api/websites'),
        headers: {},
        maxResponseBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  test('keeps the deadline active while a response body stalls after headers', async () => {
    const stream = new ReadableStream<Uint8Array>({});

    await expect(
      sendRequest(async () => new Response(stream), {
        method: 'get',
        url: new URL('https://example.com/api/websites'),
        headers: {},
        timeout: 20,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  test('honors caller cancellation while the response body is pending', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({});
    const response = sendRequest(async () => new Response(stream), {
      method: 'get',
      url: new URL('https://example.com/api/websites'),
      headers: {},
      signal: controller.signal,
    });

    controller.abort();

    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('does not hide an oversized error response behind its HTTP status', async () => {
    await expect(
      sendRequest(async () => new Response('oversized', { status: 502 }), {
        method: 'get',
        url: new URL('https://example.com/api/websites'),
        headers: {},
        maxResponseBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  test('rejects disabled or effectively unbounded resource limits', async () => {
    const fetchImpl = async () => new Response('{}');
    const request = {
      method: 'get' as const,
      url: new URL('https://example.com/api/websites'),
      headers: {},
    };

    await expect(sendRequest(fetchImpl, { ...request, timeout: 0 })).rejects.toThrow(RangeError);
    await expect(
      sendRequest(fetchImpl, { ...request, maxResponseBytes: Infinity }),
    ).rejects.toThrow(RangeError);
  });
});
