import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { ok } from '@/lib/response';
import { clearSessionCookies } from '@/lib/session';

export async function POST(request: Request) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return clearSessionCookies(error());
  }

  if (redis.enabled && auth?.authKey) {
    await redis.client.del(auth.authKey);
  }

  return clearSessionCookies(ok());
}
