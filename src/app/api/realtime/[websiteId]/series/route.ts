import { getRealtimeView } from '../view';

export async function GET(request: Request, context: { params: Promise<{ websiteId: string }> }) {
  return getRealtimeView(request, context, 'series');
}
