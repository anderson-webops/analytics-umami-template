import { z } from 'zod';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { filterParams, pagingParams } from '@/lib/schema';
import { getPagedShareWorkMultiplier } from '@/lib/share-query-budget';
import type { PageResult } from '@/lib/types';
import { canViewWebsiteSection } from '@/permissions';
import { EventDataPageTooBroadError, getEventData } from '@/queries/sql/events/getEventData';

interface EventDataRow {
  websiteId: string;
  sessionId: string;
  eventId: string;
  eventName: string;
  urlPath: string;
  dataKey: string;
  stringValue: string | null;
  numberValue: number | null;
  dateValue: Date | string | null;
  dataType: number;
  createdAt: Date | string;
}

type EventProperty = Omit<
  EventDataRow,
  'websiteId' | 'sessionId' | 'eventId' | 'eventName' | 'urlPath'
>;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    ...filterParams,
    ...pagingParams,
  });

  const { auth, query, error } = await parseRequest(request, schema, {
    shareQueryWorkMultiplier: query => getPagedShareWorkMultiplier(query.page, query.pageSize),
    capShareCount: true,
  });

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsiteSection(auth, websiteId, 'events'))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  let result: PageResult<EventDataRow[]>;
  try {
    result = (await getEventData(websiteId, filters)) as PageResult<EventDataRow[]>;
  } catch (caught) {
    if (caught instanceof EventDataPageTooBroadError) {
      return badRequest({ message: caught.message });
    }

    throw caught;
  }

  const { data: rows, count, page, pageSize } = result;

  const eventMap = new Map<
    string,
    { websiteId: string; eventId: string; eventName: string; eventProperties: EventProperty[] }
  >();

  for (const { websiteId, sessionId, eventId, eventName, urlPath, ...props } of rows) {
    const eventKey = JSON.stringify([websiteId, sessionId, eventId, eventName, urlPath]);
    let entry = eventMap.get(eventKey);
    if (!entry) {
      entry = { websiteId, eventId, eventName, eventProperties: [] };
      eventMap.set(eventKey, entry);
    }
    entry.eventProperties.push(props);
  }

  return json({ data: [...eventMap.values()], count, page, pageSize });
}
