import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { type CacheToken, hasCurrentCacheGeneration } from '@/lib/cache-token';
import {
  type CollectionKeyBinding,
  hasActiveCollectionKey,
  matchesCollectionOwner,
} from '@/lib/collection-proof';
import { secret } from '@/lib/crypto';
import { getAllowedTrackingOrigin } from '@/lib/tracking-origin';

export type CollectionFeature = 'record' | 'heatmap';

const AUDIENCE = 'umami-collection-recording';
const ISSUER = 'umami-collector';
const MAX_PERMIT_SECONDS = 60;

interface CollectionPermit {
  type: 'collection-permit-v1';
  websiteId: string;
  sessionId: string;
  visitId: string;
  feature: CollectionFeature;
  origin: string;
  domain: string;
  keyDigest: string;
  ownerType: 'user' | 'team';
  ownerId: string;
  generation: number;
  consent: true;
  maskLevel: 'strict';
}

function signingKey() {
  return createHmac('sha256', secret()).update('collection-permit-v1').digest();
}

export function createCollectionPermit(
  cache: CacheToken,
  feature: CollectionFeature,
  binding: CollectionKeyBinding,
  origin: string,
  domain: string,
) {
  const payload: CollectionPermit = {
    type: 'collection-permit-v1',
    websiteId: cache.websiteId,
    sessionId: cache.sessionId,
    visitId: cache.visitId,
    feature,
    origin,
    domain,
    keyDigest: binding.keyDigest,
    ownerType: binding.ownerType,
    ownerId: binding.ownerId,
    generation: binding.generation,
    consent: true,
    maskLevel: 'strict',
  };

  return jwt.sign(payload, signingKey(), {
    algorithm: 'HS256',
    audience: AUDIENCE,
    issuer: ISSUER,
    expiresIn: MAX_PERMIT_SECONDS,
  });
}

export function hasCollectionPermit(
  token: string | null,
  cache: CacheToken,
  feature: CollectionFeature,
  origin: string | null,
  currentWebsite?: {
    userId: string | null;
    teamId: string | null;
    collectionGeneration: number;
    domain: string | null;
  },
) {
  if (!token || token.length > 4096 || !origin) {
    return false;
  }

  try {
    const payload = jwt.verify(token, signingKey(), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      issuer: ISSUER,
    });

    if (!payload || typeof payload !== 'object') {
      return false;
    }

    return (
      payload.type === 'collection-permit-v1' &&
      payload.websiteId === cache.websiteId &&
      payload.sessionId === cache.sessionId &&
      payload.visitId === cache.visitId &&
      payload.feature === feature &&
      payload.origin === origin &&
      typeof payload.domain === 'string' &&
      payload.consent === true &&
      payload.maskLevel === 'strict' &&
      typeof payload.keyDigest === 'string' &&
      (payload.ownerType === 'user' || payload.ownerType === 'team') &&
      typeof payload.ownerId === 'string' &&
      Number.isSafeInteger(payload.generation) &&
      hasActiveCollectionKey(
        cache.websiteId,
        payload as unknown as CollectionKeyBinding,
        'recorder',
      ) &&
      (!currentWebsite ||
        (hasCurrentCacheGeneration(cache, currentWebsite.collectionGeneration) &&
          matchesCollectionOwner(payload as unknown as CollectionKeyBinding, currentWebsite) &&
          payload.domain === currentWebsite.domain &&
          getAllowedTrackingOrigin(origin, currentWebsite.domain) === origin))
    );
  } catch {
    return false;
  }
}
