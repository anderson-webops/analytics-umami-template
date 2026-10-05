import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { canViewSharedWebsite } from '@/permissions';
import { getWebsiteDateRange } from '@/queries/sql';

const schema = z.object({});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, error } = await parseRequest(request, schema, { budgetShareQuery: true });

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewSharedWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const dateRange = await getWebsiteDateRange(websiteId);

  return json(dateRange);
}
