import { saveAuth } from '@/lib/auth';
import { ENROLLMENT_AUTH_TOKEN_TYPE, PARTIAL_AUTH_TOKEN_TYPE, ROLES } from '@/lib/constants';
import { hash, secret } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { createSecureToken } from '@/lib/jwt';
import { clearFailedLogins, getLoginLimit, recordFailedLogin } from '@/lib/login-rate-limit';
import { checkPassword, hashPassword, passwordNeedsRehash } from '@/lib/password';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { json, notFound, serviceUnavailable, tooManyRequests, unauthorized } from '@/lib/response';
import { getAuthSessionTtlSeconds } from '@/lib/security';
import { isSameOriginMutation, setSessionCookie } from '@/lib/session';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { getTwoFactorRequirement } from '@/lib/two-factor/requirement';
import { getAllUserTeams, getUserByUsername } from '@/queries/prisma';
import { replacePasswordIfCurrent } from '@/queries/prisma/user';
import { loginRequestSchema } from './schema';

const DUMMY_PASSWORD_HASH = '$2b$12$dzX/8VLqsHliwcW1P2rlnuxNhqzhg00Jqq7s6vi/PNkMuBsbgJHGi';

async function rejectInvalidCredentials(username: string) {
  const accountLimit = await recordFailedLogin(username);

  return accountLimit.blocked
    ? tooManyRequests(accountLimit.retryAfter, {
        message: 'Too many login attempts. Please try again later.',
      })
    : unauthorized({ code: 'incorrect-username-password' });
}

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

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

  const { body, error } = await parseRequest(request, loginRequestSchema, {
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

  if (password === 'umami') {
    return rejectInvalidCredentials(username);
  }

  const user = await getUserByUsername(username, { includePassword: true });
  const passwordMatches = await checkPassword(password, user?.password || DUMMY_PASSWORD_HASH);

  if (!user || !passwordMatches) {
    return rejectInvalidCredentials(username);
  }

  const { id, role, createdAt } = user;
  const authClient = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const twoFactor = await authClient.twoFactorAuth.findUnique({ where: { userId: id } });

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
  await clearFailedLogins(request, username);

  if (twoFactor?.isEnabled) {
    if (!isTwoFactorConfigured()) {
      return serviceUnavailable(getTwoFactorConfigurationError());
    }

    const partialToken = createSecureToken(
      { userId: id, pwd: passwordFingerprint, type: PARTIAL_AUTH_TOKEN_TYPE },
      secret(),
      { expiresIn: '5m' },
    );

    return json({ requiresTwoFactor: true, partialToken });
  }

  const enrollmentRequired = (await getTwoFactorRequirement(id)).reason !== null;
  if (enrollmentRequired && !isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const sessionTtl = enrollmentRequired ? 15 * 60 : getAuthSessionTtlSeconds();
  const sessionData = {
    userId: id,
    role,
    pwd: passwordFingerprint,
    ...(enrollmentRequired ? { type: ENROLLMENT_AUTH_TOKEN_TYPE } : {}),
  };
  const token = redis.enabled
    ? await saveAuth(sessionData, sessionTtl)
    : createSecureToken(sessionData, secret(), {
        expiresIn: sessionTtl,
      });
  const teams = enrollmentRequired ? [] : await getAllUserTeams(id);

  return setSessionCookie(
    json({
      token,
      user: { id, username, role, createdAt, isAdmin: role === ROLES.admin, teams },
    }),
    token,
    sessionTtl,
  );
}
