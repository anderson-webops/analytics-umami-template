import { z } from 'zod';
import { saveAuth } from '@/lib/auth';
import { ROLES } from '@/lib/constants';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import { clearFailedLogins, getLoginLimit } from '@/lib/login-rate-limit';
import { checkPassword, hashPassword, passwordNeedsRehash } from '@/lib/password';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { json, tooManyRequests, unauthorized } from '@/lib/response';
import { loginPasswordParam } from '@/lib/schema';
import { getAuthSessionTtlSeconds } from '@/lib/security';
import { isSameOriginMutation, setSessionCookie } from '@/lib/session';
import { getAllUserTeams, getUserByUsername } from '@/queries/prisma';
import { replacePasswordIfCurrent } from '@/queries/prisma/user';

const DUMMY_PASSWORD_HASH = '$2b$12$dzX/8VLqsHliwcW1P2rlnuxNhqzhg00Jqq7s6vi/PNkMuBsbgJHGi';

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();

  if (
    !contentType.startsWith('application/json') ||
    fetchSite === 'cross-site' ||
    (origin && !isSameOriginMutation(request))
  ) {
    return unauthorized({ code: 'invalid-login-origin' });
  }

  const schema = z.object({
    username: z.string().trim().min(1).max(255),
    password: loginPasswordParam,
  });

  const { body, error } = await parseRequest(request, schema, {
    skipAuth: true,
    maxBodyBytes: 16 * 1024,
  });

  if (error) {
    return error();
  }

  const { username, password } = body;
  const loginLimit = await getLoginLimit(request, username);

  if (loginLimit.blocked) {
    return tooManyRequests(loginLimit.retryAfter, {
      message: 'Too many login attempts. Please try again later.',
    });
  }

  const user = await getUserByUsername(username, { includePassword: true });
  const passwordMatches = await checkPassword(password, user?.password || DUMMY_PASSWORD_HASH);

  if (!user || !passwordMatches) {
    return unauthorized({ code: 'incorrect-username-password' });
  }

  const { id, role, createdAt } = user;
  let passwordHash = user.password;

  if (passwordNeedsRehash(passwordHash)) {
    const nextPasswordHash = await hashPassword(password);

    try {
      await replacePasswordIfCurrent(id, passwordHash, nextPasswordHash);
    } catch (error: any) {
      if (error?.message === 'USER_CREDENTIALS_CHANGED') {
        return unauthorized({ code: 'credentials-changed' });
      }

      throw error;
    }

    passwordHash = nextPasswordHash;
  }

  const passwordFingerprint = hash(passwordHash);
  const sessionTtl = getAuthSessionTtlSeconds();

  let token: string;

  if (redis.enabled) {
    token = await saveAuth({ userId: id, role, pwd: passwordFingerprint }, sessionTtl);
  } else {
    token = createSecureToken({ userId: user.id, role, pwd: passwordFingerprint }, secret(), {
      expiresIn: sessionTtl,
    });
  }

  await clearFailedLogins(request, username);

  const teams = await getAllUserTeams(id);

  return setSessionCookie(
    json({
      token,
      user: { id, username, role, createdAt, isAdmin: role === ROLES.admin, teams },
    }),
    token,
    sessionTtl,
  );
}
