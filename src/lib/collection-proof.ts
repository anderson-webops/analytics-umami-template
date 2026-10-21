import { createHash, timingSafeEqual } from 'node:crypto';
import { parseCollectionServerKeys } from '../../scripts/collection-key-config.mjs';

export type CollectionScope = 'event' | 'identity' | 'revenue' | 'recorder';

export type CollectionKeyBinding = {
  keyDigest: string;
  ownerType: 'user' | 'team';
  ownerId: string;
  generation: number;
};

type CollectionKey = Omit<CollectionKeyBinding, 'keyDigest'> & {
  sha256: string;
  scopes: CollectionScope[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43,128}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_TIMESTAMP = /^[0-9]{10}$/;

export interface BackendCollectionRequest extends CollectionKeyBinding {
  requestId: string;
}

export class CollectionRequestReplayError extends Error {
  constructor() {
    super('COLLECTION_REQUEST_REPLAYED');
  }
}

function getConfiguredKeys(websiteId: string): CollectionKey[] {
  const configured = process.env.COLLECTION_SERVER_KEYS_JSON;

  if (!configured) {
    return [];
  }

  const parsed = parseCollectionServerKeys(configured) as Record<string, CollectionKey[]> | null;

  return parsed?.[websiteId] ?? [];
}

function getMatchingKey(
  request: Request,
  websiteId: string,
  requiredScopes: CollectionScope[],
): CollectionKey | null {
  const authorization = request.headers.get('authorization');
  const credential = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!CREDENTIAL.test(credential) || !UUID.test(websiteId) || !requiredScopes.length) {
    return null;
  }

  const digest = createHash('sha256').update(credential).digest();

  for (const key of getConfiguredKeys(websiteId)) {
    if (
      requiredScopes.every(scope => key.scopes.includes(scope)) &&
      timingSafeEqual(digest, Buffer.from(key.sha256, 'hex'))
    ) {
      return key;
    }
  }

  return null;
}

export function getBackendCollectionProof(
  request: Request,
  websiteId: string,
  requiredScopes: CollectionScope[],
): string | null {
  return getMatchingKey(request, websiteId, requiredScopes)?.sha256 ?? null;
}

export function getBackendCollectionRequest(
  request: Request,
  websiteId: string,
  requiredScopes: CollectionScope[],
): BackendCollectionRequest | null {
  const key = getMatchingKey(request, websiteId, requiredScopes);
  const requestId = request.headers.get('x-umami-request-id');
  const timestamp = request.headers.get('x-umami-request-timestamp');

  if (
    !key ||
    !requestId ||
    !REQUEST_ID.test(requestId) ||
    !timestamp ||
    !REQUEST_TIMESTAMP.test(timestamp) ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300
  ) {
    return null;
  }

  return {
    keyDigest: key.sha256,
    ownerType: key.ownerType,
    ownerId: key.ownerId,
    generation: key.generation,
    requestId: requestId.toLowerCase(),
  };
}

export function hasActiveCollectionKey(
  websiteId: string,
  binding: CollectionKeyBinding,
  scope: CollectionScope,
) {
  return getConfiguredKeys(websiteId).some(
    key =>
      key.sha256 === binding.keyDigest &&
      key.ownerType === binding.ownerType &&
      key.ownerId === binding.ownerId &&
      key.generation === binding.generation &&
      key.scopes.includes(scope),
  );
}

export function matchesCollectionOwner(
  binding: CollectionKeyBinding,
  source: { userId: string | null; teamId: string | null; collectionGeneration: number } | null,
) {
  return (
    !!source &&
    source.collectionGeneration === binding.generation &&
    (binding.ownerType === 'team'
      ? source.teamId === binding.ownerId && source.userId === null
      : source.userId === binding.ownerId && source.teamId === null)
  );
}
