import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { ok, unauthorized } from '@/lib/response';
import { clearSessionCookies, isSameOriginMutation } from '@/lib/session';
import { runCredentialRevocationMutation } from '@/queries/prisma/authorization';
import { revokeStatelessSessions } from '@/queries/prisma/user';

export async function POST(request: Request) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    const response = error();
    return isSameOriginMutation(request) ? clearSessionCookies(response) : response;
  }

  if (auth?.authType !== 'session' || !auth.user?.id) {
    return unauthorized();
  }

  const sessionGeneration = auth.sessionGeneration ?? 0;

  if (redis.enabled && auth.authKey) {
    await runCredentialRevocationMutation(async () => {
      await redis.client.del(auth.authKey);
    });
  } else if (Number.isSafeInteger(sessionGeneration) && sessionGeneration >= 0) {
    await revokeStatelessSessions(auth.user.id, sessionGeneration);
  } else {
    return unauthorized();
  }

  return clearSessionCookies(ok());
}
