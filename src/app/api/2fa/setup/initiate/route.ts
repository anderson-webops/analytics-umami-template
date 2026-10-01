import { isEnvEnabled } from '@/lib/env';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { badRequest, conflict, json, notFound, serviceUnavailable } from '@/lib/response';
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

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  // Secrets cannot be stored without an encryption key
  if (!isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const userId = auth.user.id;
  const user = await getUser(userId);

  if (!user) {
    return badRequest({ message: 'User not found' });
  }

  const existing = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });

  if (existing?.isEnabled) {
    return badRequest({
      code: 'two-factor-error-already-enabled',
      message: '2FA is already enabled',
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
