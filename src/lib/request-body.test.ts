import { expect, test } from 'vitest';
import {
  getJsonBody,
  getRequestBodySize,
  RequestBodyTooLargeError,
  readRequestBodyBytes,
} from './request-body';

test('exposes only the completed byte count for the same request instance', async () => {
  const body = JSON.stringify({ message: 'UTF-8: café' }) + ' '.repeat(20);
  const request = new Request('https://analytics.example/api/send', { method: 'POST', body });
  const other = request.clone();
  expect(getRequestBodySize(request)).toBeUndefined();
  expect(await getJsonBody(request)).toEqual({ message: 'UTF-8: café' });
  expect(getRequestBodySize(request)).toBe(Buffer.byteLength(body, 'utf8'));
  expect(getRequestBodySize(other)).toBeUndefined();
  expect(request.bodyUsed).toBe(true);
});

test('records an empty body without creating a stream', async () => {
  const request = new Request('https://analytics.example/api/send', { method: 'POST' });
  expect(await readRequestBodyBytes(request)).toEqual(new Uint8Array());
  expect(getRequestBodySize(request)).toBe(0);
});

test('retains the received size for malformed JSON without accepting it', async () => {
  const request = new Request('https://analytics.example/api/send', {
    method: 'POST',
    body: '{invalid',
  });
  expect(await getJsonBody(request)).toBeUndefined();
  expect(getRequestBodySize(request)).toBe(8);
});

test('oversized advertised bodies have no successful size receipt', async () => {
  const request = new Request('https://analytics.example/api/send', {
    method: 'POST',
    headers: { 'Content-Length': '16385' },
    body: '{}',
  });
  await expect(readRequestBodyBytes(request, 16384)).rejects.toBeInstanceOf(
    RequestBodyTooLargeError,
  );
  expect(getRequestBodySize(request)).toBeUndefined();
});

test('bounds actual bytes when the sender understates the body size', async () => {
  const request = new Request('https://analytics.example/api/send', {
    method: 'POST',
    headers: { 'Content-Length': '1' },
    body: 'x'.repeat(16385),
  });
  await expect(readRequestBodyBytes(request, 16384)).rejects.toBeInstanceOf(
    RequestBodyTooLargeError,
  );
  expect(getRequestBodySize(request)).toBeUndefined();
});
