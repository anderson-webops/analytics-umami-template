import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getApiUrl } from '@/lib/api-url';
import { SHARE_CONTEXT_HEADER, SHARE_TOKEN_HEADER } from '@/lib/constants';
import { type FetchResponse, httpDelete, httpGet, httpPatch, httpPost, httpPut } from '@/lib/fetch';
import { useApp } from '@/store/app';

async function handleResponse(res: FetchResponse): Promise<any> {
  if (!res.ok) {
    const { message, code, status } = res?.data?.error || {};

    return Promise.reject(Object.assign(new Error(message), { code, status }));
  }
  return Promise.resolve(res.data);
}

export function useApi() {
  const shareId = useApp(state => state.share?.shareId);
  const shareToken = useApp(state => state.shareToken?.token);

  const getHeaders = useCallback(
    (headers: object = {}) => ({
      ...(shareId && shareToken
        ? { [SHARE_TOKEN_HEADER]: shareToken, [SHARE_CONTEXT_HEADER]: '1' }
        : {}),
      ...headers,
    }),
    [shareId, shareToken],
  );

  return {
    get: useCallback(
      async (url: string, params: object = {}, headers: object = {}) => {
        return httpGet(getApiUrl(url), params, getHeaders(headers)).then(handleResponse);
      },
      [getHeaders],
    ),

    post: useCallback(
      async (url: string, params: object = {}, headers: object = {}) => {
        return httpPost(getApiUrl(url), params, getHeaders(headers)).then(handleResponse);
      },
      [getHeaders],
    ),

    put: useCallback(
      async (url: string, params: object = {}, headers: object = {}) => {
        return httpPut(getApiUrl(url), params, getHeaders(headers)).then(handleResponse);
      },
      [getHeaders],
    ),

    patch: useCallback(
      async (url: string, params: object = {}, headers: object = {}) => {
        return httpPatch(getApiUrl(url), params, getHeaders(headers)).then(handleResponse);
      },
      [getHeaders],
    ),
    del: useCallback(
      async (url: string, params: object = {}, headers: object = {}) => {
        return httpDelete(getApiUrl(url), params, getHeaders(headers)).then(handleResponse);
      },
      [getHeaders],
    ),
    useQuery,
    useMutation,
  };
}
