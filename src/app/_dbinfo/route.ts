import { canAccessInternalDiagnostics, forbiddenResponse, getDbInfo } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!canAccessInternalDiagnostics(request)) {
    return forbiddenResponse();
  }

  return Response.json(getDbInfo(), {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
