import { isEnvEnabled } from '@/lib/env';
import { checkPassword } from '@/lib/password';
import { reservePasswordVerificationAttempt } from '@/lib/password-verification-rate-limit';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  conflict,
  forbidden,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import {
  encryptSecret,
  getTwoFactorConfigurationError,
  isTwoFactorConfigured,
} from '@/lib/two-factor/crypto';
import {
  generateOtpAuthUri,
  generateQrCodeDataUrl,
  generateTotpSecret,
} from '@/lib/two-factor/totp';
import { getUser } from '@/queries/prisma/user';
import { initiateTwoFactorSetupSchema } from './schema';

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, body, error } = await parseRequest(request, initiateTwoFactorSetupSchema, {
    maxBodyBytes: 16 * 1024,
  });

  if (error) {
    return error();
  }

  if (auth.authType !== 'session' || !auth.user?.id) {
    return unauthorized();
  }

  if (auth.enrollmentOnly && isEnvEnabled('DISABLE_LOGIN')) {
    return forbidden({ code: 'login-disabled' });
  }

  // Secrets cannot be stored without an encryption key
  if (!isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const userId = auth.user.id;
  const user = await getUser(userId, { includePassword: true });

  if (!user) {
    return unauthorized();
  }

  const existing = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });

  if (existing?.isEnabled) {
    return badRequest({
      code: 'two-factor-error-already-enabled',
      message: '2FA is already enabled',
    });
  }

  let passwordAttempt;

  try {
    passwordAttempt = await reservePasswordVerificationAttempt(userId);
  } catch {
    return serviceUnavailable({ message: 'Credential verification is temporarily unavailable' });
  }

  if (!passwordAttempt.allowed) {
    return tooManyRequests(passwordAttempt.retryAfter, {
      message: 'Too many password attempts',
    });
  }

  if (!(await checkPassword(body.password, user.password))) {
    return badRequest({
      code: 'two-factor-error-incorrect-password',
      message: 'Incorrect password',
    });
  }

  const secret = generateTotpSecret();
  const encryptedSecret = encryptSecret(secret);
  const otpAuthUri = generateOtpAuthUri(secret, user.username);
  const qrCodeDataUrl = await generateQrCodeDataUrl(otpAuthUri);

  const written = existing
    ? await prisma.client.twoFactorAuth.updateMany({
        where: { id: existing.id, userId, secret: existing.secret, isEnabled: false },
        data: { secret: encryptedSecret },
      })
    : await prisma.client.twoFactorAuth.createMany({
        data: [{ userId, secret: encryptedSecret, isEnabled: false }],
        skipDuplicates: true,
      });

  if (written.count !== 1) {
    return conflict({
      code: 'two-factor-error-setup-changed',
      message: '2FA setup changed; start again',
    });
  }

  /*
  `manualKey` is intentionally plaintext as the user needs it once for manual entry.
  The encrypted copy in DB is what matters for long-term storage.
   */
  return json({ qrCodeDataUrl, manualKey: secret });
}
