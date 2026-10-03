import debug from 'debug';
import {
  API_KEY_LAST_USED_INTERVAL,
  getCanonicalApiPath,
  hashApiKey,
  isApiKey,
  isApiKeyBlockedRequest,
  isApiKeyEnabled,
} from '@/lib/api-key';
import {
  ENROLLMENT_AUTH_TOKEN_TYPE,
  PARTIAL_AUTH_TOKEN_TYPE,
  ROLE_PERMISSIONS,
  ROLES,
  SHARE_CONTEXT_HEADER,
  SHARE_TOKEN_HEADER,
  SHARE_TOKEN_TYPE,
} from '@/lib/constants';
import { createAuthKey, hash, secret } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { createSecureToken, parseSecureToken, parseToken } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { getAuthSessionTtlSeconds, publicSharesDisabled } from '@/lib/security';
import { getBearerToken, getSessionCookie, isSameOriginMutation } from '@/lib/session';
import { resolveShareAccess } from '@/lib/share-access';
import { getTwoFactorRequirement } from '@/lib/two-factor/requirement';
import { ensureArray } from '@/lib/utils';
import { getShare } from '@/queries/prisma';
import { getApiKeyByHash, updateApiKeyLastUsed } from '@/queries/prisma/apiKey';
import { getUser } from '@/queries/prisma/user';

const log = debug('umami:auth');

const ENROLLMENT_REQUESTS = new Set([
  'GET /api/2fa/status',
  'POST /api/2fa/setup/initiate',
  'POST /api/2fa/setup/confirm',
  'POST /api/2fa/setup/cancel',
  'POST /api/auth/verify',
  'POST /api/auth/logout',
]);

function isEnrollmentRequest(request: Request) {
  const path = getCanonicalApiPath(new URL(request.url).pathname);
  return ENROLLMENT_REQUESTS.has(`${request.method.toUpperCase()} ${path}`);
}

async function needsTwoFactorEnrollment(userId: string) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return false;
  }

  const requirement = await getTwoFactorRequirement(userId);
  return requirement.reason !== null;
}

export async function checkApiKeyAuth(request: Request, token: string) {
  const { pathname } = new URL(request.url);

  if (isApiKeyBlockedRequest(pathname, request.method)) {
    log('API key not allowed for request', request.method, pathname);
    return null;
  }

  const apiKey = await getApiKeyByHash(hashApiKey(token));
  if (!apiKey) {
    log('API key not found');
    return null;
  }

  const user: any = await getUser(apiKey.userId);
  if (!user?.id) {
    log('API key user not found');
    return null;
  }

  if (await needsTwoFactorEnrollment(user.id)) {
    const authClient = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
    const enrollment = await authClient.twoFactorAuth.findUnique({
      where: { userId: user.id },
      select: { isEnabled: true },
    });

    if (!enrollment?.isEnabled) {
      log('API key user must enroll in required 2FA');
      return null;
    }
  }

  const lastUsedAt = apiKey.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - lastUsedAt > API_KEY_LAST_USED_INTERVAL) {
    updateApiKeyLastUsed(apiKey.id).catch(error => log(error));
  }

  delete user.password;
  user.isAdmin = user.role === ROLES.admin;

  return {
    token,
    user,
    source: 'bearer' as const,
    authType: 'api-key' as const,
    apiKey: { id: apiKey.id, name: apiKey.name },
  };
}

export async function checkAuth(request: Request) {
  const bearerToken = getBearerToken(request);
  const cookieToken = bearerToken ? null : getSessionCookie(request);
  const token = bearerToken || cookieToken;
  const source = bearerToken ? 'bearer' : cookieToken ? 'cookie' : null;

  if (bearerToken && isApiKeyEnabled() && isApiKey(bearerToken)) {
    return checkApiKeyAuth(request, bearerToken);
  }

  const payload = parseSecureToken(token, secret());

  if (payload?.type === PARTIAL_AUTH_TOKEN_TYPE) {
    log('Partial auth token rejected');
    return null;
  }

  const shareToken = await parseShareToken(request);

  let user = null;
  let mfaVerified = false;
  let mfaId: string | undefined;
  let enrollmentOnly = false;
  const { userId, authKey } = payload || {};

  if (userId) {
    mfaVerified = payload?.mfa === true;
    mfaId = typeof payload?.mfaId === 'string' ? payload.mfaId : undefined;
    enrollmentOnly = payload?.type === ENROLLMENT_AUTH_TOKEN_TYPE;
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
      mfaVerified = key.mfa === true;
      mfaId = typeof key.mfaId === 'string' ? key.mfaId : undefined;
      enrollmentOnly = key.type === ENROLLMENT_AUTH_TOKEN_TYPE;
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
    if (enrollmentOnly && isEnvEnabled('CLOUD_MODE')) {
      log('Enrollment session not valid in cloud mode');
      return null;
    }

    if (!isEnvEnabled('CLOUD_MODE')) {
      const authClient = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
      const enrollment = await authClient.twoFactorAuth.findUnique({
        where: { userId: user.id },
        select: { id: true, isEnabled: true },
      });

      if (enrollment?.isEnabled) {
        mfaVerified = mfaVerified && !!mfaId && mfaId === enrollment.id && !enrollmentOnly;
      } else {
        mfaVerified = false;
      }

      if (enrollment?.isEnabled && !mfaVerified) {
        log('Session lacks verified 2FA');
        return null;
      }

      const enrollmentRequired =
        !enrollment?.isEnabled && (await needsTwoFactorEnrollment(user.id));

      if (enrollmentRequired && !enrollmentOnly) {
        log('Fresh login required for 2FA enrollment');
        return null;
      }

      if (enrollmentOnly && (!enrollmentRequired || !isEnrollmentRequest(request))) {
        log('Session limited to required 2FA enrollment');
        return null;
      }
    }

    delete user.password;
    user.isAdmin = user.role === ROLES.admin;
  }

  return {
    token,
    authKey,
    shareToken,
    source,
    user,
    authType: user ? ('session' as const) : ('share' as const),
    mfaVerified,
    mfaId: mfaVerified ? mfaId : undefined,
    enrollmentOnly,
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
