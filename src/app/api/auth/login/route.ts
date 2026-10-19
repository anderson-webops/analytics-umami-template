import { randomUUID } from 'node:crypto';
import { saveAuth } from '@/lib/auth';
import { ENROLLMENT_AUTH_TOKEN_TYPE, PARTIAL_AUTH_TOKEN_TYPE, ROLES } from '@/lib/constants';
import { hash, secret } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { createSecureToken } from '@/lib/jwt';
import { isLoginCaptchaEnabled, verifyLoginCaptcha } from '@/lib/login-captcha';
import {
  clearFailedLogins,
  getLoginLimit,
  recordFailedLogin,
  releaseLoginAccountAttempt,
  releaseLoginOverflowAttempt,
  releaseLoginPasswordWork,
  reserveLoginAccountAttempt,
  reserveLoginOverflowAttempt,
  reserveLoginPasswordWork,
} from '@/lib/login-rate-limit';
import { checkPassword, hashPassword, passwordNeedsRehash } from '@/lib/password';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import {
  forbidden,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import { getAuthSessionTtlSeconds } from '@/lib/security';
import { isSameOriginMutation, setSessionCookie } from '@/lib/session';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { getTwoFactorRequirement } from '@/lib/two-factor/requirement';
import { getAllUserTeams, getUserByUsername } from '@/queries/prisma';
import { rehashPasswordIfCurrent } from '@/queries/prisma/user';
import { loginRequestSchema } from './schema';

const DUMMY_PASSWORD_HASH = '$2b$12$dzX/8VLqsHliwcW1P2rlnuxNhqzhg00Jqq7s6vi/PNkMuBsbgJHGi';

async function rejectInvalidCredentials(username: string, captchaEnabled: boolean) {
  if (captchaEnabled) {
    return unauthorized({ code: 'incorrect-username-password' });
  }

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

  if (isEnvEnabled('DISABLE_LOGIN')) {
    return forbidden({ code: 'login-disabled' });
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

  const { username, password, captchaToken } = body;
  const loginLimit = await getLoginLimit(request, username);

  if (loginLimit.blocked) {
    return tooManyRequests(loginLimit.retryAfter, {
      message: 'Too many login attempts. Please try again later.',
    });
  }

  const captchaEnabled = isLoginCaptchaEnabled();

  if (captchaEnabled) {
    const captchaResult = await verifyLoginCaptcha(captchaToken, request.url);

    if (captchaResult === 'unavailable') {
      return serviceUnavailable({ message: 'Login verification is temporarily unavailable' });
    }

    if (captchaResult !== 'valid') {
      return unauthorized({ code: 'captcha-required', message: 'Complete login verification' });
    }
  }

  if (password === 'umami') {
    return rejectInvalidCredentials(username, captchaEnabled);
  }

  let workLease;
  try {
    workLease = await reserveLoginPasswordWork();
  } catch {
    return serviceUnavailable({ message: 'Login verification is temporarily unavailable' });
  }

  if (!workLease) {
    return serviceUnavailable({ message: 'Login verification is temporarily unavailable' });
  }

  let accountLimit: Awaited<ReturnType<typeof reserveLoginAccountAttempt>>;
  let user: Awaited<ReturnType<typeof getUserByUsername>>;
  let passwordMatches: boolean;
  let overflow: Awaited<ReturnType<typeof reserveLoginOverflowAttempt>> | null = null;

  try {
    try {
      accountLimit = await reserveLoginAccountAttempt(username);
      if (accountLimit.blocked && captchaEnabled) {
        overflow = await reserveLoginOverflowAttempt(username);
      }
    } catch {
      return serviceUnavailable({ message: 'Login verification is temporarily unavailable' });
    }

    if (accountLimit.blocked && (!overflow || overflow.blocked)) {
      return unauthorized({ code: 'incorrect-username-password' });
    }

    user = await getUserByUsername(username, {
      includePassword: true,
      includeSessionGeneration: true,
    });
    passwordMatches = await checkPassword(password, user?.password || DUMMY_PASSWORD_HASH);
  } finally {
    if (overflow && 'windowExpiresAt' in overflow) {
      await releaseLoginOverflowAttempt(username, overflow.windowExpiresAt, overflow.leaseId).catch(
        () => undefined,
      );
    }
    await releaseLoginPasswordWork(workLease).catch(() => undefined);
  }

  if (!user || !passwordMatches) {
    return rejectInvalidCredentials(username, captchaEnabled);
  }

  const { id, role, createdAt, sessionGeneration } = user;
  const authClient = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const twoFactor = await authClient.twoFactorAuth.findUnique({ where: { userId: id } });

  let passwordHash = user.password;

  if (passwordNeedsRehash(passwordHash)) {
    const nextPasswordHash = await hashPassword(password);

    try {
      await rehashPasswordIfCurrent(id, passwordHash, nextPasswordHash, sessionGeneration);
    } catch (error: any) {
      if (error?.message === 'USER_CREDENTIALS_CHANGED') {
        return unauthorized({ code: 'credentials-changed' });
      }

      throw error;
    }

    passwordHash = nextPasswordHash;
  }

  const passwordFingerprint = hash(passwordHash);
  const accountAttempt =
    'windowExpiresAt' in accountLimit
      ? {
          accountAttemptId: randomUUID(),
          accountAttemptExpiresAt: accountLimit.windowExpiresAt,
          accountAttemptKeyVersion: 2,
        }
      : {};

  if (twoFactor?.isEnabled) {
    if (!isTwoFactorConfigured()) {
      return serviceUnavailable(getTwoFactorConfigurationError());
    }

    const partialToken = await createSecureToken(
      {
        userId: id,
        pwd: passwordFingerprint,
        sessionGeneration,
        ...accountAttempt,
        type: PARTIAL_AUTH_TOKEN_TYPE,
      },
      secret(),
      { expiresIn: '5m' },
    );

    return json({ requiresTwoFactor: true, partialToken });
  }

  const enrollmentRequired = (await getTwoFactorRequirement(id)).reason !== null;
  if (enrollmentRequired && !isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  if (!enrollmentRequired && 'windowExpiresAt' in accountLimit) {
    try {
      await releaseLoginAccountAttempt(username, accountLimit.windowExpiresAt);
    } catch {
      return serviceUnavailable({ message: 'Login verification is temporarily unavailable' });
    }
  }

  const sessionTtl = enrollmentRequired ? 15 * 60 : getAuthSessionTtlSeconds();
  const sessionData = {
    userId: id,
    role,
    pwd: passwordFingerprint,
    sessionGeneration,
    ...(enrollmentRequired ? { type: ENROLLMENT_AUTH_TOKEN_TYPE, ...accountAttempt } : {}),
  };
  const token = redis.enabled
    ? await saveAuth(sessionData, sessionTtl)
    : await createSecureToken(sessionData, secret(), {
        expiresIn: sessionTtl,
      });
  const teams = enrollmentRequired ? [] : await getAllUserTeams(id);

  if (!enrollmentRequired) {
    await clearFailedLogins(request, username);
  }

  return setSessionCookie(
    json({
      token,
      user: { id, username, role, createdAt, isAdmin: role === ROLES.admin, teams },
    }),
    token,
    sessionTtl,
  );
}
