import { afterEach, expect, test, vi } from 'vitest';
import { getBackendCollectionProof } from '@/lib/collection-proof';
import {
  getTestCollectionCredential,
  getTestCollectionServerKeysJson,
} from '../seed/collection-keys';
import { SEED_IDS } from '../seed/ids';

afterEach(() => vi.unstubAllEnvs());

test('disposable API credentials are distinct, website-scoped, and omit revenue', () => {
  vi.stubEnv('COLLECTION_SERVER_KEYS_JSON', getTestCollectionServerKeysJson());

  const primary = getTestCollectionCredential(SEED_IDS.website);
  const secondary = getTestCollectionCredential(SEED_IDS.website2);

  expect(primary).not.toBe(secondary);
  expect(primary).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(secondary).toMatch(/^[A-Za-z0-9_-]{43}$/);

  for (const [websiteId, credential] of [
    [SEED_IDS.website, primary],
    [SEED_IDS.website2, secondary],
  ]) {
    const request = new Request('https://analytics.example/api/send', {
      headers: { authorization: `Bearer ${credential}` },
    });

    expect(getBackendCollectionProof(request, websiteId, ['identity', 'event'])).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(getBackendCollectionProof(request, websiteId, ['recorder'])).toMatch(/^[0-9a-f]{64}$/);
    expect(getBackendCollectionProof(request, websiteId, ['revenue'])).toBeNull();
  }

  const primaryRequest = new Request('https://analytics.example/api/send', {
    headers: { authorization: `Bearer ${primary}` },
  });

  expect(getBackendCollectionProof(primaryRequest, SEED_IDS.website2, ['event'])).toBeNull();
  expect(() => getTestCollectionCredential(SEED_IDS.link)).toThrow(
    'Unknown disposable API test website.',
  );
});
