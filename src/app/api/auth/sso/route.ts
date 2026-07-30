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

  const user = await getUser(auth.user.id, { includePassword: true });

  if (!user) {
    return unauthorized();
  }

  const sessionTtl = getAuthSessionTtlSeconds();
  const token = await saveAuth(
    { userId: auth.user.id, role: auth.user.role, pwd: hash(user.password) },
    sessionTtl,
  );

  return setSessionCookie(json({ user: auth.user, token }), token, sessionTtl);
}
