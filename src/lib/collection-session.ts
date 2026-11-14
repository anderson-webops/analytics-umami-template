import { randomUUID } from 'node:crypto';
import { startOfHour } from 'date-fns';
import { type CacheToken, hasCurrentCacheGeneration } from '@/lib/cache-token';
import type { BackendCollectionRequest } from '@/lib/collection-proof';
import { getSalt, hash, uuid } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';

export function resolveCollectionSession({
  sourceId,
  websiteId,
  ip,
  userAgent,
  distinctId,
  sessionSeed,
  salt,
  createdAt,
  cache,
  collectionGeneration,
  backendRequest,
  historical = false,
}: {
  sourceId: string;
  websiteId?: string;
  ip: string;
  userAgent: string;
  distinctId?: string;
  sessionSeed?: string;
  salt?: string;
  createdAt: Date;
  cache?: CacheToken | null;
  collectionGeneration?: number;
  backendRequest?: BackendCollectionRequest | null;
  historical?: boolean;
}) {
  if (distinctId !== undefined && !backendRequest) {
    throw new Error('Backend collection authorization required.');
  }
  if (
    websiteId &&
    (websiteId !== sourceId ||
      typeof collectionGeneration !== 'number' ||
      !Number.isSafeInteger(collectionGeneration) ||
      collectionGeneration < 0)
  ) {
    throw new Error('COLLECTION_SOURCE_GENERATION_MISSING');
  }
  if (backendRequest && !websiteId)
    throw new Error('Backend collection requires a website source.');

  const browserCache =
    !backendRequest &&
    websiteId &&
    cache?.websiteId.toLowerCase() === websiteId &&
    hasCurrentCacheGeneration(cache, collectionGeneration ?? 0)
      ? cache
      : null;
  const now = Math.floor(Date.now() / 1000);
  const baseSalt = getSalt(process.env.SALT_ROTATION || 'month', createdAt);
  const sessionSalt = isEnvEnabled('ENABLE_CLIENT_SALT') && salt ? hash(baseSalt, salt) : baseSalt;
  const visitSalt = hash(startOfHour(createdAt).toUTCString());
  const identityHash = hash(distinctId ?? '');
  const sessionSourceId =
    websiteId && collectionGeneration ? `${sourceId}:generation:${collectionGeneration}` : sourceId;
  const sessionId = backendRequest
    ? sessionSeed || distinctId
      ? uuid(
          'verified-collection-v2',
          sessionSourceId,
          sessionSeed ?? '',
          distinctId ?? '',
          sessionSalt,
        )
      : randomUUID()
    : !websiteId
      ? uuid(sourceId, ip, userAgent, sessionSalt, distinctId ?? '')
      : sessionSeed
        ? uuid(sessionSourceId, sessionSeed, sessionSalt, distinctId ?? '')
        : browserCache?.identityHash === identityHash && browserCache.sessionSalt === sessionSalt
          ? browserCache.sessionId
          : randomUUID();
  const sessionDrift =
    !!websiteId && !!browserCache?.sessionId && browserCache.sessionId !== sessionId;
  let visitId = browserCache?.visitId || uuid(sessionId, visitSalt);
  let iat = browserCache?.iat || now;
  if (sessionDrift || (!historical && now - iat > 1800)) {
    visitId = uuid(sessionId, visitSalt);
    iat = now;
  }
  return { sessionId, visitId, iat, sessionDrift, sessionSalt, identityHash };
}
