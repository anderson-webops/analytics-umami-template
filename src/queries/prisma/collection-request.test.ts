import { expect, test, vi } from 'vitest';
import { CollectionRequestReplayError } from '@/lib/collection-proof';
import {
  reserveActiveCollectionBudget,
  reserveBackendCollectionRequest,
  withActiveCollectionSource,
} from './collection';

const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { transaction: transactionMock } }));

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WEBSITE_ID = '22222222-2222-4222-8222-222222222222';
const KEY_DIGEST = 'a'.repeat(64);
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

test('atomic backend request reservation rejects duplicates across key rotation and isolates sites', async () => {
  const reserved = new Set<string>();
  const transaction = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray, requestKey: string) => {
      expect(query.join('?')).toContain(
        'ON CONFLICT (subject_type, subject_key, scope, window_start) DO NOTHING',
      );
      expect(requestKey).toMatch(/^nonce:[0-9a-f]{58}$/);

      if (reserved.has(requestKey)) {
        return [];
      }

      reserved.add(requestKey);
      return [{ requests: 1n }];
    }),
    $executeRaw: vi.fn(async () => 0),
  };
  const first = {
    keyDigest: KEY_DIGEST,
    ownerType: 'user' as const,
    ownerId: '44444444-4444-4444-8444-444444444444',
    generation: 0,
    requestId: REQUEST_ID,
  };

  await reserveBackendCollectionRequest(transaction as any, WEBSITE_ID, first);
  await expect(
    reserveBackendCollectionRequest(transaction as any, WEBSITE_ID, first),
  ).rejects.toBeInstanceOf(CollectionRequestReplayError);
  await reserveBackendCollectionRequest(transaction as any, OTHER_WEBSITE_ID, first);
  await expect(
    reserveBackendCollectionRequest(transaction as any, WEBSITE_ID, {
      ...first,
      keyDigest: 'b'.repeat(64),
    }),
  ).rejects.toBeInstanceOf(CollectionRequestReplayError);
  await reserveBackendCollectionRequest(transaction as any, WEBSITE_ID, {
    ...first,
    requestId: '44444444-4444-4444-8444-444444444444',
  });

  expect(reserved.size).toBe(3);
  expect(transaction.$executeRaw).toHaveBeenCalledTimes(3);
});

test('backend admission and writes reject a transferred owner and a return transfer', async () => {
  const ownerId = '44444444-4444-4444-8444-444444444444';
  const source = { id: WEBSITE_ID, userId: ownerId, teamId: null, collectionGeneration: 0 };
  const transaction = {
    $queryRaw: vi.fn(async () => []),
    website: { findFirst: vi.fn(async () => source) },
  };
  transactionMock.mockImplementation(async operation => operation(transaction));
  const proof = {
    keyDigest: KEY_DIGEST,
    ownerType: 'user' as const,
    ownerId,
    generation: 0,
    requestId: REQUEST_ID,
  };
  const operation = vi.fn(async () => 'written');

  await expect(withActiveCollectionSource('website', WEBSITE_ID, operation, proof)).resolves.toBe(
    'written',
  );
  source.userId = '55555555-5555-4555-8555-555555555555';
  source.collectionGeneration = 1;

  await expect(withActiveCollectionSource('website', WEBSITE_ID, operation, proof)).rejects.toThrow(
    'COLLECTION_KEY_OWNER_CHANGED',
  );
  await expect(
    reserveActiveCollectionBudget(
      'website',
      WEBSITE_ID,
      { type: 'event', payload: {} },
      '192.0.2.10',
      'backend',
      proof,
    ),
  ).rejects.toThrow('COLLECTION_KEY_OWNER_CHANGED');

  source.userId = ownerId;
  source.collectionGeneration = 2;
  await expect(withActiveCollectionSource('website', WEBSITE_ID, operation, proof)).rejects.toThrow(
    'COLLECTION_KEY_OWNER_CHANGED',
  );
  expect(operation).toHaveBeenCalledTimes(1);
});
