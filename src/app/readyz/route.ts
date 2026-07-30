import { canAccessInternalDiagnostics, getReadiness, readyResponse } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const readiness = await getReadiness();
  const body = canAccessInternalDiagnostics(request)
    ? readiness
    : {
        ready: readiness.ready,
      };

  return readyResponse(readiness.ready ? 200 : 503, body);
}
