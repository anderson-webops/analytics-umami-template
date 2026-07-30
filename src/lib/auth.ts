import debug from 'debug';
import {
  ROLE_PERMISSIONS,
  ROLES,
  SHARE_CONTEXT_HEADER,
  SHARE_TOKEN_HEADER,
  SHARE_TOKEN_TYPE,
} from '@/lib/constants';
import { createAuthKey, hash, secret } from '@/lib/crypto';
import { createSecureToken, parseSecureToken, parseToken } from '@/lib/jwt';
import redis from '@/lib/redis';
import { getAuthSessionTtlSeconds, publicSharesDisabled } from '@/lib/security';
import { getBearerToken, getSessionCookie, isSameOriginMutation } from '@/lib/session';
import { resolveShareAccess } from '@/lib/share-access';
import { ensureArray } from '@/lib/utils';
import { getShare } from '@/queries/prisma';
import { getUser } from '@/queries/prisma/user';

const log = debug('umami:auth');

export async function checkAuth(request: Request) {
  const bearerToken = getBearerToken(request);
  const cookieToken = bearerToken ? null : getSessionCookie(request);
  const token = bearerToken || cookieToken;
  const source = bearerToken ? 'bearer' : cookieToken ? 'cookie' : null;
  const payload = parseSecureToken(token, secret());
  const shareToken = await parseShareToken(request);

  let user = null;
  const { userId, authKey } = payload || {};

  if (userId) {
    user = await getUser(userId, { includePassword: true });

    if (
      !payload.pwd ||
      !payload.role ||
      (user && (hash(user.password) !== payload.pwd || user.role !== payload.role))
    ) {
      user = null;
    }
  } else if (redis.enabled && authKey) {
    const key = await redis.client.get(authKey);

    if (key?.userId) {
      user = await getUser(key.userId, { includePassword: true });

      if (
        !key.pwd ||
        !key.role ||
        (user && (hash(user.password) !== key.pwd || user.role !== key.role))
      ) {
        user = null;
      }
    }
  }

  if (source === 'cookie' && !isSameOriginMutation(request)) {
    log('Rejected cross-origin cookie-authenticated mutation');
    return null;
  }

  log({
    hasToken: !!token,
    hasPayload: !!payload,
    hasAuthKey: !!authKey,
    hasShareToken: !!shareToken,
    userId: user?.id,
    source,
  });

  if (!user?.id && !shareToken) {
    log('User not authorized');
    return null;
  }

  if (!user?.id && shareToken) {
    const shareContext = request.headers.get(SHARE_CONTEXT_HEADER);
    if (!shareContext) {
      log('Share token used outside share context');
      return null;
    }
  }

  if (user) {
    delete user.password;
    user.isAdmin = user.role === ROLES.admin;
  }

  return {
    token,
    authKey,
    shareToken,
    source,
    user,
  };
}

export async function saveAuth(data: any, expire = getAuthSessionTtlSeconds()) {
  const authKey = `auth:${createAuthKey()}`;

  if (redis.enabled) {
    await redis.client.set(authKey, data, expire);
  }

  return createSecureToken({ authKey }, secret(), { expiresIn: expire });
}

export async function hasPermission(role: string, permission: string | string[]) {
  return ensureArray(permission).some(e => ROLE_PERMISSIONS[role]?.includes(e));
}

export async function parseShareToken(request: Request) {
  if (publicSharesDisabled()) {
    return null;
  }

  try {
    const token: any = parseToken(request.headers.get(SHARE_TOKEN_HEADER), secret());

    if (token?.type !== SHARE_TOKEN_TYPE || typeof token.shareId !== 'string') {
      return null;
    }

    const share = await getShare(token.shareId);

    if (!share || share.shareType !== token.shareType) {
      return null;
    }

    const access = await resolveShareAccess(share);

    return access ? { ...access.data, type: SHARE_TOKEN_TYPE } : null;
  } catch {
    log('Unable to parse share token');
    return null;
  }
}
