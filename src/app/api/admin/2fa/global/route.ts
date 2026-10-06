import { z } from 'zod';
import { isEnvEnabled } from '@/lib/env';
import { parseRequest } from '@/lib/request';
import { json, notFound, serviceUnavailable, unauthorized } from '@/lib/response';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { canEnforceTwoFactorAuthForEveryone } from '@/permissions';
import { runAuthorizedAdministratorMutation } from '@/queries/prisma/authorization';

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const schema = z.object({ required: z.boolean() });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  if (!(await canEnforceTwoFactorAuthForEveryone(auth))) {
    return unauthorized();
  }

  const { required } = body;

  if (required && !isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  try {
    await runAuthorizedAdministratorMutation(auth.user.id, transaction =>
      transaction.appSetting.upsert({
        where: { key: 'twoFactorRequiredGlobal' },
        update: { value: String(required) },
        create: { key: 'twoFactorRequiredGlobal', value: String(required) },
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'ENTITY_ADMIN_REQUIRED') {
      return unauthorized({ message: 'Your administrator permission changed.' });
    }

    throw error;
  }

  return json({ ok: true, required });
}
