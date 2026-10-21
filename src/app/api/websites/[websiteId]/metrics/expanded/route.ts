import { z } from 'zod';
import { EVENT_COLUMNS, EVENT_TYPE, SESSION_COLUMNS } from '@/lib/constants';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { metricResponse } from '@/lib/metric-provenance';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, unauthorized } from '@/lib/response';
import {
  filterParams,
  queryLimitParam,
  queryOffsetParam,
  searchParams,
  withDateRange,
} from '@/lib/schema';
import { getMetricShareSections } from '@/lib/share';
import { getMetricShareWorkMultiplier } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import {
  getChannelExpandedMetrics,
  getEventExpandedMetrics,
  getPageviewExpandedMetrics,
  getSessionExpandedMetrics,
} from '@/queries/sql';

const metricTypeParam = z
  .string()
  .refine(
    value =>
      SESSION_COLUMNS.includes(value) || EVENT_COLUMNS.includes(value) || value === 'channel',
    'Unsupported metric type.',
  );

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = withDateRange({
    type: metricTypeParam,
    limit: queryLimitParam.optional(),
    offset: queryOffsetParam.optional(),
    ...searchParams,
    ...filterParams,
  });

  const { auth, query, error } = await parseRequest(request, schema, {
    shareQueryWorkMultiplier: query =>
      getMetricShareWorkMultiplier(query.type, query.limit, query.offset),
  });

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { type, limit, offset, search } = query;
  const sections = getMetricShareSections(type)?.filter(
    section => section === 'overview' || section === 'compare',
  );

  if (!sections || !(await canViewWebsiteSection(auth, websiteId, sections))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  if (search) {
    filters[type] = `c.${search}`;
  }

  try {
    if (SESSION_COLUMNS.includes(type)) {
      return metricResponse(
        await getSessionExpandedMetrics(websiteId, { type, limit, offset }, filters),
        type,
      );
    }

    if (EVENT_COLUMNS.includes(type)) {
      if (type === 'event') {
        filters.eventType = EVENT_TYPE.customEvent;
        return metricResponse(
          await getEventExpandedMetrics(websiteId, { type, limit, offset }, filters),
          type,
        );
      } else {
        return metricResponse(
          await getPageviewExpandedMetrics(websiteId, { type, limit, offset }, filters),
          type,
        );
      }
    }

    if (type === 'channel') {
      return metricResponse(await getChannelExpandedMetrics(websiteId, filters), type);
    }
  } catch (error) {
    if (error instanceof IdentitySearchTooBroadError) {
      return badRequest({ message: 'Identity search is too broad.' });
    }
    throw error;
  }

  return badRequest();
}
