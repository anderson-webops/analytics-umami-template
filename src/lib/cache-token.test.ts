import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CACHE_TOKEN_TYPE } from '@/lib/constants';
import { hash } from '@/lib/crypto';
import { createToken, parseToken } from '@/lib/jwt';
import { createCacheToken, parseCacheToken } from './cache-token';

const SECRET = 'synthetic-cache-secret-0123456789abcdef';
const OTHER_SECRET = 'different-cache-secret-0123456789abcdef';
const payload = {
  websiteId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  visitId: '33333333-3333-4333-8333-333333333333',
  iat: Math.floor(Date.now() / 1000),
  identityHash: hash(''),
  sessionSalt: hash('synthetic-month'),
  sessionLinkId: '44444444-4444-4444-8444-444444444444',
};

describe('collector cache token', () => {
  test('encrypts signed session state with a fresh nonce', () => {
    const first = createCacheToken(payload, SECRET, 3600);
    const second = createCacheToken(payload, SECRET, 3600);

    expect(first).not.toBe(second);
    expect(first).not.toContain(payload.sessionId);
    expect(first).not.toContain(payload.visitId);
    expect(parseToken(first, SECRET)).toBeNull();
    expect(parseCacheToken(first, SECRET)).toMatchObject({
      ...payload,
      type: CACHE_TOKEN_TYPE,
      version: 2,
    });
    expect(parseCacheToken(second, SECRET)).toMatchObject({
      ...payload,
      type: CACHE_TOKEN_TYPE,
      version: 2,
    });
  });

  test('rejects tampering, wrong secrets, malformed encodings, and oversized input', () => {
    const token = createCacheToken(payload, SECRET, 3600);
    const last = token.at(-1);
    const changed = `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;

    for (const invalid of [changed, 'c1.!!!', 'c1.YQ', `${token}/`, 'x'.repeat(4097)]) {
      expect(parseCacheToken(invalid, SECRET)).toBeNull();
    }
    expect(parseCacheToken(token, OTHER_SECRET)).toBeNull();
  });

  test('rejects pre-fix signed cache tokens, expired tokens, and other purposes', () => {
    const legacy = createToken({ ...payload, type: CACHE_TOKEN_TYPE }, SECRET, { expiresIn: 3600 });
    const expired = createToken({ ...payload, type: CACHE_TOKEN_TYPE }, SECRET, { expiresIn: -1 });
    const other = createToken({ ...payload, type: 'share' }, SECRET, { expiresIn: 3600 });

    expect(parseCacheToken(legacy, SECRET)).toBeNull();
    expect(parseCacheToken(expired, SECRET)).toBeNull();
    expect(parseCacheToken(other, SECRET)).toBeNull();
  });

  test('rejects an encrypted pre-fix cache token without renewing its session', () => {
    const context = 'umami-collector-cache-v1';
    const signed = createToken({ ...payload, type: CACHE_TOKEN_TYPE }, SECRET, {
      expiresIn: 3600,
    });
    const iv = randomBytes(12);
    const key = createHmac('sha256', SECRET).update(context).digest();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(signed, 'utf8'), cipher.final()]);
    const legacy = `c1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;

    expect(parseCacheToken(legacy, SECRET)).toBeNull();
  });

  test('rejects a versioned token without bound identity and rotation state', () => {
    const incomplete = createToken(
      { ...payload, type: CACHE_TOKEN_TYPE, version: 2, identityHash: undefined },
      SECRET,
      { expiresIn: 3600 },
    );
    const wrongVersion = createToken({ ...payload, type: CACHE_TOKEN_TYPE, version: 3 }, SECRET, {
      expiresIn: 3600,
    });

    expect(parseCacheToken(incomplete, SECRET)).toBeNull();
    expect(parseCacheToken(wrongVersion, SECRET)).toBeNull();
  });
});
