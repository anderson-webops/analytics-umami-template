import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCacheToken, parseCacheToken } from '@/lib/cache-token';
import type { BackendCollectionRequest } from '@/lib/collection-proof';
import { hash, secret } from '@/lib/crypto';
import { resolveCollectionSession } from './collection-session';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const SEED = '22222222-2222-4222-8222-222222222222';
const base = {
  sourceId: SOURCE,
  websiteId: SOURCE,
  collectionGeneration: 0,
  ip: '192.0.2.10',
  userAgent: 'Synthetic browser',
  createdAt: new Date('2026-11-14T12:00:00Z'),
};
const backendRequest: BackendCollectionRequest = {
  keyDigest: 'a'.repeat(64),
  ownerType: 'user',
  ownerId: SOURCE,
  generation: 0,
  requestId: SEED,
};
const session = (overrides: Partial<Parameters<typeof resolveCollectionSession>[0]> = {}) =>
  resolveCollectionSession({ ...base, ...overrides });
function cache(overrides = {}) {
  const value = session({ sessionSeed: SEED });
  return parseCacheToken(
    createCacheToken(
      {
        websiteId: SOURCE,
        collectionGeneration: 0,
        sessionId: value.sessionId,
        visitId: value.visitId,
        iat: value.iat,
        sessionSalt: value.sessionSalt,
        identityHash: value.identityHash,
        ...overrides,
      },
      secret(),
      3600,
    ),
    secret(),
  );
}

afterEach(() => vi.unstubAllEnvs());

describe('canonical collection sessions', () => {
  test('keeps separate browser sessions behind an identical IP and user agent', () => {
    expect(session().sessionId).not.toBe(session().sessionId);
  });
  test('a browsing seed remains stable across IP and user-agent changes', () => {
    expect(session({ sessionSeed: SEED }).sessionId).toBe(
      session({ sessionSeed: SEED, ip: '192.0.2.20', userAgent: 'Other browser' }).sessionId,
    );
  });
  test('independent browsing seeds remain distinct', () => {
    expect(session({ sessionSeed: SEED }).sessionId).not.toBe(
      session({ sessionSeed: SOURCE }).sessionId,
    );
  });
  test('reuses only a current, same-website, same-rotation cache', () => {
    const value = cache();
    expect(session({ cache: value }).sessionId).toBe(value.sessionId);
    expect(session({ cache: value }).visitId).toBe(value.visitId);
    expect(session({ cache: value, collectionGeneration: 1 }).sessionId).not.toBe(value.sessionId);
    expect(session({ cache: cache({ websiteId: SEED }) }).sessionId).not.toBe(value.sessionId);
    expect(
      session({ cache: value, createdAt: new Date('2026-12-14T12:00:00Z') }).sessionId,
    ).not.toBe(value.sessionId);
  });
  test('restarts a visit after the bounded inactivity period', () => {
    const value = cache({ visitId: 'previous-visit', iat: Math.floor(Date.now() / 1000) - 1801 });
    const next = session({ cache: value });
    expect(next.sessionId).toBe(value.sessionId);
    expect(next.visitId).not.toBe(value.visitId);
    expect(next.iat).toBeGreaterThan(value.iat);
  });
  test('historical backend collection does not reuse a public visit', () => {
    const value = cache({ visitId: 'public-visit' });
    const next = session({
      backendRequest,
      cache: value,
      distinctId: 'verified-user',
      historical: true,
    });
    expect(next.sessionId).not.toBe(value.sessionId);
    expect(next.visitId).not.toBe(value.visitId);
  });
  test('requires a backend proof before resolving distinct identities', () => {
    expect(() => session({ distinctId: 'untrusted' })).toThrow(
      'Backend collection authorization required.',
    );
    const value = session({ backendRequest, distinctId: 'verified-user' });
    expect(value.sessionId).toBe(
      session({ backendRequest, distinctId: 'verified-user' }).sessionId,
    );
    expect(value.sessionId).not.toBe(
      session({ backendRequest, distinctId: 'other-user' }).sessionId,
    );
  });
  test.each([undefined, -1, Number.NaN])(
    'rejects an unverified source generation %s',
    collectionGeneration => {
      expect(() => session({ collectionGeneration })).toThrow(
        'COLLECTION_SOURCE_GENERATION_MISSING',
      );
    },
  );
  test('source recreation changes seeded anonymous and verified sessions', () => {
    for (const proof of [undefined, backendRequest]) {
      expect(session({ sessionSeed: SEED, backendRequest: proof }).sessionId).not.toBe(
        session({ sessionSeed: SEED, backendRequest: proof, collectionGeneration: 1 }).sessionId,
      );
    }
  });
  test('retains isolated non-website source fingerprint behavior', () => {
    const value = session({ websiteId: undefined });
    expect(value.sessionId).toBe(session({ websiteId: undefined }).sessionId);
    expect(() => session({ websiteId: undefined, backendRequest })).toThrow(
      'Backend collection requires a website source.',
    );
  });
});

describe('client salt', () => {
  test.each(['false', '0', 'off', 'no', ''])('is ignored for false-valued flags: %s', flag => {
    vi.stubEnv('ENABLE_CLIENT_SALT', flag);
    expect(session({ sessionSeed: SEED, salt: 'client' }).sessionId).toBe(
      session({ sessionSeed: SEED }).sessionId,
    );
  });
  test('splits sessions with a supported salt while retaining server rotation', () => {
    vi.stubEnv('ENABLE_CLIENT_SALT', 'true');
    const value = session({ sessionSeed: SEED, salt: 'client' });
    expect(value.sessionId).toBe(session({ sessionSeed: SEED, salt: 'client' }).sessionId);
    expect(value.sessionId).not.toBe(session({ sessionSeed: SEED, salt: 'other' }).sessionId);
    expect(value.sessionId).not.toBe(
      session({ sessionSeed: SEED, salt: 'client', createdAt: new Date('2026-12-14T12:00:00Z') })
        .sessionId,
    );
    expect(value.sessionSalt).not.toBe(hash('client'));
  });
});
