import { expect, test } from 'vitest';
import { getAllowedFrameAncestors, getContentSecurityPolicy } from './csp';

test('production CSP retains the complete build policy without broad runtime allowances', () => {
  const policy = getContentSecurityPolicy({
    NODE_ENV: 'production',
    API_URL: 'https://api.example.test/api',
    CLOUD_URL: 'https://cloud.example.test',
    TURNSTILE_SITE_KEY: 'synthetic-key',
    ALLOWED_FRAME_URLS: 'https://portal.example.test, https://other.example.test',
  });

  for (const directive of [
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "font-src 'self' data:",
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "connect-src 'self' https://api.example.test https://cloud.example.test https://challenges.cloudflare.com",
    "frame-src 'self' https:",
    "frame-ancestors 'self' https://portal.example.test https://other.example.test",
    'upgrade-insecure-requests',
  ]) {
    expect(policy).toContain(`${directive};`);
  }

  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy).not.toContain('connect-src https:');
  expect(policy).not.toContain('frame-src http:');
});

test('development CSP preserves debugger and local frame support', () => {
  const policy = getContentSecurityPolicy({
    NODE_ENV: 'development',
    API_URL: '/api',
    ALLOWED_FRAME_URLS: 'http://127.0.0.1:3000',
  });

  expect(policy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval';");
  expect(policy).toContain("connect-src 'self';");
  expect(policy).toContain("frame-src 'self' https: http:;");
  expect(policy).toContain("frame-ancestors 'self' http://127.0.0.1:3000;");
  expect(policy).not.toContain('upgrade-insecure-requests');
});

test('unconfigured framing fails closed and invalid origins cannot inject directives', () => {
  expect(getContentSecurityPolicy({ NODE_ENV: 'production' })).toContain("frame-ancestors 'none';");
  expect(
    getAllowedFrameAncestors('https://portal.example.test, https://portal.example.test', true),
  ).toEqual(['https://portal.example.test']);

  for (const origin of [
    'http://portal.example.test',
    'https://portal.example.test/path',
    'https://portal.example.test?next=1',
    'https://portal.example.test; script-src https:',
    'https://user:pass@portal.example.test',
  ]) {
    expect(() => getAllowedFrameAncestors(origin, true)).toThrow(/ALLOWED_FRAME_URLS/);
  }
});

test('runtime CSP includes API and cloud origins embedded in the client build', () => {
  const policy = getContentSecurityPolicy({
    NODE_ENV: 'production',
    API_URL: 'https://runtime-api.example.test',
    apiUrl: 'https://build-api.example.test/api',
    cloudUrl: 'https://build-cloud.example.test',
  });

  expect(policy).toContain(
    "connect-src 'self' https://runtime-api.example.test https://build-api.example.test https://build-cloud.example.test;",
  );
});
