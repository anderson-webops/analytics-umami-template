import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { CACHE_TOKEN_TYPE } from '@/lib/constants';
import { createToken, parseToken } from '@/lib/jwt';

const PREFIX = 'c1.';
const CONTEXT = 'umami-collector-cache-v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MAX_TOKEN_LENGTH = 4096;
const CACHE_TOKEN_VERSION = 2;

export interface CacheToken {
  websiteId: string;
  sessionId: string;
  visitId: string;
  iat: number;
  identityHash: string;
  sessionSalt: string;
  sessionLinkId?: string;
  type: typeof CACHE_TOKEN_TYPE;
  version: typeof CACHE_TOKEN_VERSION;
}

function getKey(secret: string) {
  return createHmac('sha256', secret).update(CONTEXT).digest();
}

export function createCacheToken(
  payload: Omit<CacheToken, 'type' | 'version'>,
  secret: string,
  ttlSeconds: number,
) {
  const signed = createToken(
    { ...payload, type: CACHE_TOKEN_TYPE, version: CACHE_TOKEN_VERSION },
    secret,
    {
      expiresIn: ttlSeconds,
    },
  );
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getKey(secret), iv);
  cipher.setAAD(Buffer.from(CONTEXT));
  const encrypted = Buffer.concat([cipher.update(signed, 'utf8'), cipher.final()]);

  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}

export function parseCacheToken(
  token: string | null | undefined,
  secret: string,
): CacheToken | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  let signed = token;

  if (token.startsWith(PREFIX)) {
    const encoded = token.slice(PREFIX.length);

    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      return null;
    }

    const bytes = Buffer.from(encoded, 'base64url');

    if (bytes.length <= IV_LENGTH + TAG_LENGTH || bytes.toString('base64url') !== encoded) {
      return null;
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        getKey(secret),
        bytes.subarray(0, IV_LENGTH),
      );
      decipher.setAAD(Buffer.from(CONTEXT));
      decipher.setAuthTag(bytes.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
      signed = Buffer.concat([
        decipher.update(bytes.subarray(IV_LENGTH + TAG_LENGTH)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }

  const payload = parseToken(signed, secret);

  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.type !== CACHE_TOKEN_TYPE ||
    payload.version !== CACHE_TOKEN_VERSION ||
    typeof payload.websiteId !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.visitId !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.identityHash !== 'string' ||
    !/^[0-9a-f]{128}$/.test(payload.identityHash) ||
    typeof payload.sessionSalt !== 'string' ||
    !/^[0-9a-f]{128}$/.test(payload.sessionSalt) ||
    (payload.sessionLinkId !== undefined && typeof payload.sessionLinkId !== 'string')
  ) {
    return null;
  }

  return payload as CacheToken;
}
