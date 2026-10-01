import { isEnvEnabled } from '@/lib/env';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { getTwoFactorRequirement } from '@/lib/two-factor/requirement';

export async function GET(request: Request) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (isEnvEnabled('CLOUD_MODE')) {
    return json({
      isEnabled: false,
      isRequired: false,
      requiredReason: null,
      isConfigured: false,
      globalRequired: false,
    });
  }

  const userId = auth.user.id;

  const twoFactor = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });
  const isEnabled = twoFactor?.isEnabled ?? false;

  const requirement = await getTwoFactorRequirement(userId);
  const isConfigured = isTwoFactorConfigured();

  return json({
    isEnabled,
    isRequired: isConfigured && requirement.reason !== null,
    requiredReason: isConfigured ? requirement.reason : null,
    isConfigured,
    globalRequired: requirement.globalRequired,
  });
}
