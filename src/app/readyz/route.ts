import { getReadiness, readyResponse } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const readiness = await getReadiness();

  return readyResponse(readiness.ready ? 200 : 503, readiness);
}
