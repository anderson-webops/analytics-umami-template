import { UmamiApiError, type UmamiApiErrorBody } from './errors';
import type { HttpMethod, OperationDefinition } from './generated/operations';
import type { FetchLike, RequestOptions, UmamiClientOptions } from './types';

export const DEFAULT_BASE_URL = 'https://api.umami.is/v1';
export const API_KEY_HEADER = 'x-umami-api-key';
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

type QueryValue = string | number | boolean | Date | null | undefined | QueryValue[];

export function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, '');
}

/**
 * OpenAPI paths are documented as `/api/...`. The base URL already points at the API root
 * (`https://api.umami.is/v1` or `https://example.com/api`), so the `/api` prefix is dropped.
 */
export function stripApiPrefix(path: string) {
  return path.replace(/^\/api(?=\/|$)/, '');
}

export function buildPath(template: string, params: Record<string, unknown>) {
  return template.replace(/\{([^}]+)}/g, (_, name: string) => {
    const value = params[name];

    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing required path parameter "${name}" for ${template}`);
    }

    return encodeURIComponent(String(value));
  });
}

export function appendQuery(search: URLSearchParams, key: string, value: QueryValue) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendQuery(search, key, item);
    }

    return;
  }

  if (value instanceof Date) {
    search.append(key, value.toISOString());
    return;
  }

  search.append(key, String(value));
}

export function buildUrl(baseUrl: string, path: string, query: Record<string, unknown>) {
  const base = trimSlashes(baseUrl || DEFAULT_BASE_URL);
  const url = new URL(`${base}/${trimSlashes(stripApiPrefix(path))}`);

  for (const [key, value] of Object.entries(query)) {
    appendQuery(url.searchParams, key, value as QueryValue);
  }

  return url;
}

export function buildAuthHeaders(options: Pick<UmamiClientOptions, 'token' | 'apiKey'>) {
  const headers: Record<string, string> = {};

  if (options.apiKey) {
    headers[API_KEY_HEADER] = options.apiKey;
  }

  const bearer = options.token ?? options.apiKey;

  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }

  return headers;
}

export interface SplitInput {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  body: Record<string, unknown> | undefined;
}

/**
 * Splits a flat input object into path params, query params and body according to the operation
 * definition. Path parameters are only used to build the URL and are never sent in the query
 * string or JSON body. Unknown keys go to the query string for body-less operations (dynamic
 * filter params such as `browser1` or `pf_*`) and to the body otherwise.
 */
export function splitInput(
  operation: OperationDefinition,
  input: Record<string, unknown> = {},
): SplitInput {
  const path: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  const pathParams = new Set(operation.pathParams);
  const queryParams = new Set(operation.queryParams);

  for (const [key, value] of Object.entries(input)) {
    if (pathParams.has(key)) {
      path[key] = value;
    } else if (queryParams.has(key)) {
      query[key] = value;
    } else if (operation.hasBody) {
      body[key] = value;
    } else {
      query[key] = value;
    }
  }

  return { path, query, body: operation.hasBody ? body : undefined };
}

class ResponseBodyTooLargeError extends Error {}

function boundedPositiveInteger(value: number, maximum: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}`);
  }

  return value;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readBody(response: Response, maxResponseBytes: number, signal: AbortSignal) {
  const contentLength = Number(response.headers.get('content-length'));

  if (Number.isSafeInteger(contentLength) && contentLength > maxResponseBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyTooLargeError();
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await awaitWithAbort(reader.read(), signal);

      if (done) {
        break;
      }

      length += value.byteLength;

      if (length > maxResponseBytes) {
        throw new ResponseBodyTooLargeError();
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new TextDecoder().decode(bytes);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function parseBody(response: Response, maxResponseBytes: number, signal: AbortSignal) {
  const text = await readBody(response, maxResponseBytes, signal);

  if (!text) {
    return undefined;
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('json')) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new UmamiApiError({
      status: response.status,
      code: 'invalid-json',
      message: 'Response body is not valid JSON',
      method: 'GET',
      url: response.url,
      body: text,
    });
  }
}

export interface HttpRequest {
  method: HttpMethod;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeout?: number;
  maxResponseBytes?: number;
}

export async function sendRequest<T>(fetchImpl: FetchLike, request: HttpRequest): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
  const init: RequestInit = { method: request.method.toUpperCase(), headers };

  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(request.body);
  }

  const timeout = boundedPositiveInteger(
    request.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'timeout',
  );
  const maxResponseBytes = boundedPositiveInteger(
    request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal?.reason);

  if (request.signal?.aborted) {
    onAbort();
  } else {
    request.signal?.addEventListener('abort', onAbort, { once: true });
  }

  init.signal = controller.signal;
  const timer = setTimeout(() => {
    const error = new Error(`Request timed out after ${timeout} ms`);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeout);

  try {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }

    const response = await awaitWithAbort(fetchImpl(request.url, init), controller.signal);
    let body: unknown;

    try {
      body = await parseBody(response, maxResponseBytes, controller.signal);
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new UmamiApiError({
          status: response.status,
          code: 'response-too-large',
          message: `Response body exceeds ${maxResponseBytes} bytes`,
          method: request.method.toUpperCase(),
          url: request.url.toString(),
        });
      }

      if (!(error instanceof UmamiApiError)) {
        throw error;
      }

      if (response.ok) {
        throw new UmamiApiError({
          status: response.status,
          code: error.code,
          message: error.message,
          method: request.method.toUpperCase(),
          url: request.url.toString(),
          body: error.body,
        });
      }

      body = undefined;
    }

    if (!response.ok) {
      const error = (body as UmamiApiErrorBody | undefined)?.error;

      throw new UmamiApiError({
        status: response.status,
        code: error?.code,
        message: error?.message,
        method: request.method.toUpperCase(),
        url: request.url.toString(),
        body,
      });
    }

    return body as T;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

export function resolveFetch(custom?: FetchLike): FetchLike {
  if (custom) {
    return custom;
  }

  if (typeof fetch !== 'function') {
    throw new Error('No fetch implementation available. Pass `fetch` in UmamiClient options.');
  }

  return (input, init) => fetch(input, init);
}

export type { RequestOptions };
