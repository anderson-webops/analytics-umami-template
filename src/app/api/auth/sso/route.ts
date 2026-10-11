import { saveAuth } from '@/lib/auth';
import { hash } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { json, notFound, serverError, unauthorized } from '@/lib/response';
import { getAuthSessionTtlSeconds } from '@/lib/security';
import { setSessionCookie } from '@/lib/session';
import { getUser } from '@/queries/prisma';

export async function POST(request: Request) {
  if (!isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (!redis.enabled) {
    return serverError('Redis is disabled');
  }

  if (
    auth?.authType !== 'session' ||
    auth.source !== 'bearer' ||
    !Number.isSafeInteger(auth.expiresAt)
  ) {
    return unauthorized();
  }

  const now = Math.floor(Date.now() / 1000);
  const remaining = auth.expiresAt - now;

  if (remaining <= 0) {
    return unauthorized();
  }

  const user = await getUser(auth.user.id, {
    includePassword: true,
    includeSessionGeneration: true,
  });

  if (!user || user.sessionGeneration !== auth.sessionGeneration || user.role !== auth.user.role) {
    return unauthorized();
  }

  const currentNow = Math.floor(Date.now() / 1000);
  const sessionTtl = Math.min(getAuthSessionTtlSeconds(), auth.expiresAt - currentNow);
  if (sessionTtl <= 0) {
    return unauthorized();
  }

  const expiresAt = currentNow + sessionTtl;
  const token = await saveAuth(
    {
      userId: auth.user.id,
      role: auth.user.role,
      pwd: hash(user.password),
      sessionGeneration: auth.sessionGeneration,
    },
    sessionTtl,
    expiresAt,
  );

  return setSessionCookie(json({ user: auth.user, token }), token, sessionTtl);
}
