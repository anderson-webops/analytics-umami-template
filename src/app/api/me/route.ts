import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';

export async function GET(request: Request) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { user, apiKey, authType, shareToken } = auth;

  return json({ user, apiKey, authType, shareToken });
}
