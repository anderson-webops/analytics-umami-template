import { isEnvEnabled } from '@/lib/env';
import { parseRequest } from '@/lib/request';
import { json, notFound, unauthorized } from '@/lib/response';
import { runActiveSessionMutation, SessionRevokedError } from '@/queries/prisma/authorization';

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (auth.authType !== 'session' || !auth.user?.id) {
    return unauthorized();
  }

  const userId = auth.user.id;

  try {
    await runActiveSessionMutation(auth, transaction =>
      transaction.twoFactorAuth.deleteMany({
        where: { userId, isEnabled: false },
      }),
    );
  } catch (error) {
    if (error instanceof SessionRevokedError) {
      return unauthorized({ code: 'credentials-changed' });
    }

    throw error;
  }

  return json({ ok: true });
}
