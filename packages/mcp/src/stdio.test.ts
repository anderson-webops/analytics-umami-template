import { describe, expect, test } from 'vitest';
import { resolveClientOptions } from './stdio';

describe('resolveClientOptions', () => {
  test('appends /api to a self-hosted instance URL', () => {
    expect(
      resolveClientOptions({ UMAMI_URL: 'https://analytics.example.com/', UMAMI_API_TOKEN: 't' }),
    ).toEqual({ baseUrl: 'https://analytics.example.com/api', token: 't', apiKey: undefined });
  });

  test('uses UMAMI_API_URL verbatim', () => {
    expect(
      resolveClientOptions({ UMAMI_API_URL: 'https://api.umami.is/v1', UMAMI_API_KEY: 'k' }),
    ).toEqual({ baseUrl: 'https://api.umami.is/v1', token: undefined, apiKey: 'k' });
  });

  test('allows a bearer token with an explicit API endpoint', () => {
    expect(
      resolveClientOptions({
        UMAMI_API_URL: 'https://analytics.example.com/api',
        UMAMI_API_TOKEN: 't',
      }),
    ).toEqual({ baseUrl: 'https://analytics.example.com/api', token: 't', apiKey: undefined });
  });

  test('defaults to Cloud when only an API key is provided', () => {
    expect(resolveClientOptions({ UMAMI_API_KEY: 'api_cloud-key' }).baseUrl).toBeUndefined();
  });

  test('preserves the Cloud default when both variables hold the same Cloud key', () => {
    expect(
      resolveClientOptions({ UMAMI_API_KEY: 'api_cloud-key', UMAMI_API_TOKEN: 'api_cloud-key' })
        .baseUrl,
    ).toBeUndefined();
  });

  test('allows a self-hosted API key with an explicit instance URL', () => {
    expect(
      resolveClientOptions({
        UMAMI_URL: 'https://analytics.example.com',
        UMAMI_API_KEY: 'umami_key',
      }).baseUrl,
    ).toBe('https://analytics.example.com/api');
  });

  test.each([
    { UMAMI_API_TOKEN: 'self-hosted-token' },
    { UMAMI_API_TOKEN: 'self-hosted-token', UMAMI_API_KEY: 'api_cloud-key' },
    { UMAMI_API_KEY: 'umami_self-hosted-key' },
    { UMAMI_API_KEY: 'unknown-key' },
  ])('rejects a non-Cloud credential without an explicit API endpoint: %j', env => {
    expect(() => resolveClientOptions(env)).toThrow(/UMAMI_URL or UMAMI_API_URL/);
  });

  test.each([
    { UMAMI_API_TOKEN: 'self-hosted-token', UMAMI_API_URL: '////' },
    {
      UMAMI_API_KEY: 'api_cloud-key',
      UMAMI_API_URL: '////',
      UMAMI_URL: 'https://analytics.example.com',
    },
  ])('rejects an endpoint that collapses to the Cloud default: %j', env => {
    expect(() => resolveClientOptions(env)).toThrow(/UMAMI_API_URL must specify/);
  });

  test('requires credentials', () => {
    expect(() => resolveClientOptions({})).toThrow(/UMAMI_API_TOKEN/);
  });
});
