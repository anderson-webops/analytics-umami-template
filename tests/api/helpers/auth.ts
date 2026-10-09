import type { ApiClient, ApiResponse } from '../client';
import { nextCode } from './totp';

export interface Credentials {
  username: string;
  password: string;
}

export async function login(api: ApiClient, { username, password }: Credentials) {
  const response = await api.post('/api/auth/login', { username, password });

  if (response.status !== 200 || !response.body?.token) {
    throw new Error(`Login failed for ${username} (${response.status}): ${response.text}`);
  }

  return response.body.token as string;
}

export function sessionTokenFromCookie(response: ApiResponse) {
  const header = response.headers['set-cookie'] ?? '';
  const token = /(?:^|,\s*)(?:__Host-)?analytics-session=([^;]+)/.exec(header)?.[1];

  if (!token) {
    throw new Error('Missing session cookie in response');
  }

  return decodeURIComponent(token);
}

export async function enrollTwoFactor(api: ApiClient, credentials: Credentials) {
  const passwordToken = await login(api, credentials);
  const session = api.bearer(passwordToken);
  const initiated = await session.post('/api/2fa/setup/initiate', {
    password: credentials.password,
  });

  if (initiated.status !== 200 || !initiated.body?.manualKey) {
    throw new Error(`2FA setup failed (${initiated.status}): ${initiated.text}`);
  }

  const code = await nextCode(initiated.body.manualKey);
  const confirmed = await session.post('/api/2fa/setup/confirm', {
    token: code,
    password: credentials.password,
  });

  if (confirmed.status !== 200) {
    throw new Error(`2FA confirmation failed (${confirmed.status}): ${confirmed.text}`);
  }

  return sessionTokenFromCookie(confirmed);
}
