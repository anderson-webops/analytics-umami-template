import { renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { SHARE_CONTEXT_HEADER, SHARE_TOKEN_HEADER } from '@/lib/constants';
import { httpDelete, httpGet, httpPatch, httpPost, httpPut } from '@/lib/fetch';
import { useApi } from './useApi';

const mocks = vi.hoisted(() => ({
  state: {} as { share?: { shareId: string }; shareToken?: { token: string } },
}));

vi.mock('@/store/app', () => ({
  useApp: (selector: (state: object) => unknown) => selector(mocks.state),
}));

vi.mock('@/lib/fetch', () => ({
  httpGet: vi.fn(async () => ({ ok: true, data: {} })),
  httpPost: vi.fn(async () => ({ ok: true, data: {} })),
  httpPut: vi.fn(async () => ({ ok: true, data: {} })),
  httpPatch: vi.fn(async () => ({ ok: true, data: {} })),
  httpDelete: vi.fn(async () => ({ ok: true, data: {} })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = {};
});

test.each([
  ['get', httpGet],
  ['post', httpPost],
  ['put', httpPut],
  ['patch', httpPatch],
  ['del', httpDelete],
] as const)(
  '%s leaves browser authentication to the same-origin session cookie',
  async (method, transport) => {
    const { result } = renderHook(() => useApi());
    await result.current[method]('/me');

    expect(transport).toHaveBeenCalledExactlyOnceWith(expect.any(String), {}, {});
  },
);

test('share headers follow the current mounted context after rotation and removal', async () => {
  mocks.state = { share: { shareId: 'share-1' }, shareToken: { token: 'first-share-token' } };
  const { result, rerender } = renderHook(() => useApi());
  await result.current.get('/websites');
  expect(httpGet).toHaveBeenLastCalledWith(
    expect.any(String),
    {},
    {
      [SHARE_TOKEN_HEADER]: 'first-share-token',
      [SHARE_CONTEXT_HEADER]: '1',
    },
  );

  mocks.state = { share: { shareId: 'share-2' }, shareToken: { token: 'second-share-token' } };
  rerender();
  await result.current.get('/websites');
  expect(httpGet).toHaveBeenLastCalledWith(
    expect.any(String),
    {},
    {
      [SHARE_TOKEN_HEADER]: 'second-share-token',
      [SHARE_CONTEXT_HEADER]: '1',
    },
  );

  mocks.state = {};
  rerender();
  await result.current.get('/me');
  expect(httpGet).toHaveBeenLastCalledWith(expect.any(String), {}, {});
});

test('explicit scoped request headers are preserved without adding stored browser credentials', async () => {
  const { result } = renderHook(() => useApi());
  await result.current.post(
    '/collection-permit',
    { purpose: 'synthetic' },
    { 'x-request-id': 'request-1' },
  );

  expect(httpPost).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    { purpose: 'synthetic' },
    {
      'x-request-id': 'request-1',
    },
  );
});
