import { getReadiness, readyResponse } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function respond(method: 'GET' | 'HEAD') {
  const ready = await getReadiness();

  return readyResponse(ready, method);
}

export async function GET() {
  return respond('GET');
}

export async function HEAD() {
  return respond('HEAD');
}
