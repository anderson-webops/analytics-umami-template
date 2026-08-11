import { healthResponse } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return healthResponse();
}

export function HEAD() {
  return healthResponse('HEAD');
}
