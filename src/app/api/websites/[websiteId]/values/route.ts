import { EVENT_COLUMNS, FILTER_COLUMNS, SESSION_COLUMNS } from '@/lib/constants';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { fieldsParam, searchParams, withDateRange } from '@/lib/schema';
import { getValueShareSections } from '@/lib/share';
import { canViewSharedWebsiteFilters, canViewWebsiteSection } from '@/permissions';
import { getValues } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = withDateRange({
    type: fieldsParam,
    ...searchParams,
  });

  const { auth, query, error } = await parseRequest(request, schema, { allowShareSearch: true });

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { type } = query;
  const canFilter = await canViewSharedWebsiteFilters(auth, websiteId);
  const sections = getValueShareSections(type, canFilter);

  if (!sections || !(await canViewWebsiteSection(auth, websiteId, sections))) {
    return unauthorized();
  }

  if (!SESSION_COLUMNS.includes(type) && !EVENT_COLUMNS.includes(type)) {
    return badRequest();
  }

  const filters = await getQueryFilters(query, websiteId);
  const values = await getValues(websiteId, FILTER_COLUMNS[type], filters);

  return json(values.filter(n => n?.value != null).sort());
}
