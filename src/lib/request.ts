import { startOfMonth, subMonths } from 'date-fns';
import { z } from 'zod';
import { checkAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, FILTER_COLUMNS, OPERATORS } from '@/lib/constants';
import { getAllowedUnits, getMinimumUnit, maxDate, parseDateRange } from '@/lib/date';
import { isEnvEnabled } from '@/lib/env';
import { fetchAccount, fetchWebsite } from '@/lib/load';
import { filtersArrayToObject } from '@/lib/params';
import { badRequest, forbidden, payloadTooLarge, unauthorized } from '@/lib/response';
import { savedSegmentSchema } from '@/lib/schema';
import { hasShareFilterParams } from '@/lib/share-filter';
import type { QueryFilters } from '@/lib/types';
import { getWebsiteSegment } from '@/queries/prisma';

const MAX_QUERY_DATE_RANGE_MS = 20 * 366 * 24 * 60 * 60 * 1000;

function isValidQueryDateRange(query: Record<string, any>): boolean {
  if (query.startAt == null || query.endAt == null) {
    return true;
  }

  const startAt = Number(query.startAt);
  const endAt = Number(query.endAt);

  return (
    Number.isFinite(startAt) &&
    Number.isFinite(endAt) &&
    startAt <= endAt &&
    endAt - startAt <= MAX_QUERY_DATE_RANGE_MS
  );
}

export async function parseRequest(
  request: Request,
  schema?: any,
  options?: { skipAuth?: boolean; maxBodyBytes?: number },
): Promise<any> {
  const url = new URL(request.url);
  let query = Object.fromEntries(url.searchParams);
  let body: unknown;
  let error: () => undefined | undefined | Response;
  let auth = null;

  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    try {
      body = await getJsonBody(request, options?.maxBodyBytes);
    } catch (cause) {
      if (cause instanceof RequestBodyTooLargeError) {
        error = () => payloadTooLarge();
      }
    }
  }

  if (schema && !error) {
    const isGet = request.method === 'GET';
    const rawQuery = query;
    const result = schema.safeParse(isGet ? query : body);

    if (!result.success) {
      error = () => badRequest(z.treeifyError(result.error));
    } else if (isGet) {
      query = result.data;

      // Re-add dynamic filter params stripped by the route schema, while
      // bounding their count, key size, and value size.
      let dynamicFilterCount = 0;

      for (const key of Object.keys(rawQuery)) {
        const baseName = key.replace(/\d+$/, '');
        const isSuffixedFilter = /\d+$/.test(key) && baseName in FILTER_COLUMNS;
        const isPropertyFilter = /^pf_[A-Za-z0-9_-]+$/.test(key);

        if ((isSuffixedFilter || isPropertyFilter) && !(key in query)) {
          dynamicFilterCount += 1;

          if (dynamicFilterCount > 100 || key.length > 128 || String(rawQuery[key]).length > 500) {
            error = () => badRequest({ message: 'Too many or oversized filter parameters.' });
            break;
          }

          query[key] = rawQuery[key];
        }
      }

      if (!error && !isValidQueryDateRange(query)) {
        error = () =>
          badRequest({
            message: 'The requested date range is invalid or exceeds 20 years.',
          });
      }
    } else {
      body = result.data;
    }
  }

  if (!options?.skipAuth && !error) {
    auth = await checkAuth(request);

    if (!auth) {
      error = () => unauthorized();
    }
  }

  if (!error && auth?.shareToken?.parameters?.allowFilter === false) {
    const bodyFilters =
      body && typeof body === 'object' && !Array.isArray(body) && 'filters' in body
        ? (body as { filters?: unknown }).filters
        : null;
    const hasBodyFilters =
      !!bodyFilters &&
      typeof bodyFilters === 'object' &&
      !Array.isArray(bodyFilters) &&
      Object.keys(bodyFilters).length > 0;

    if (hasShareFilterParams(query) || hasBodyFilters) {
      error = () =>
        forbidden({
          message: 'Filters are disabled for this public share.',
          code: 'share-filters-disabled',
        });
    }
  }

  return { url, query, body, auth, error };
}

const DEFAULT_MAX_API_BODY_BYTES = 1024 * 1024;
const MIN_API_BODY_BYTES = 16 * 1024;
const MAX_API_BODY_BYTES = 10 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the configured size limit');
    this.name = 'RequestBodyTooLargeError';
  }
}

function getMaxBodyBytes(override?: number): number {
  const value = override ?? Number(process.env.MAX_API_BODY_BYTES || DEFAULT_MAX_API_BODY_BYTES);

  if (!Number.isSafeInteger(value) || value < MIN_API_BODY_BYTES || value > MAX_API_BODY_BYTES) {
    return DEFAULT_MAX_API_BODY_BYTES;
  }

  return value;
}

export async function getJsonBody(request: Request, maxBodyBytes?: number) {
  const limit = getMaxBodyBytes(maxBodyBytes);
  const contentLength = Number(request.headers.get('content-length'));

  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new RequestBodyTooLargeError();
  }

  try {
    const text = await request.clone().text();

    if (Buffer.byteLength(text, 'utf8') > limit) {
      throw new RequestBodyTooLargeError();
    }

    return text ? JSON.parse(text) : undefined;
  } catch (cause) {
    if (cause instanceof RequestBodyTooLargeError) {
      throw cause;
    }

    return undefined;
  }
}

export function getRequestDateRange(query: Record<string, string>) {
  const { startAt, endAt, unit, timezone } = query;

  const startDate = new Date(+startAt);
  const endDate = new Date(+endAt);

  return {
    startDate,
    endDate,
    timezone,
    unit: getAllowedUnits(startDate, endDate).includes(unit)
      ? unit
      : getMinimumUnit(startDate, endDate),
  };
}

export function getRequestFilters(query: Record<string, any>) {
  const result: Record<string, any> = {};

  for (const key of Object.keys(query)) {
    const baseName = key.replace(/\d+$/, '');
    if (baseName in FILTER_COLUMNS) {
      result[key] = query[key];
    }
  }

  return result;
}

export async function setWebsiteDate(websiteId: string, data: Record<string, any>) {
  const website = await fetchWebsite(websiteId);
  const cloudMode = isEnvEnabled('CLOUD_MODE');

  if (cloudMode && website && !website.teamId) {
    const account = await fetchAccount(website.userId);

    if (!account?.hasSubscription) {
      data.startDate = maxDate(data.startDate, startOfMonth(subMonths(new Date(), 6)));
    }
  }

  if (website?.resetAt) {
    data.startDate = maxDate(data.startDate, new Date(website?.resetAt));
  }

  return data;
}

export async function getQueryFilters(
  params: Record<string, any>,
  websiteId?: string,
): Promise<QueryFilters> {
  const dateRange = getRequestDateRange(params);
  const filters = getRequestFilters(params);

  let match = params?.match;

  if (websiteId) {
    await setWebsiteDate(websiteId, dateRange);

    if (params.segment) {
      const segment = await getWebsiteSegment(websiteId, params.segment);
      const parsedSegment = savedSegmentSchema.safeParse(segment);

      if (!parsedSegment.success || parsedSegment.data.type !== 'segment') {
        throw new Error('INVALID_SAVED_SEGMENT');
      }

      const segmentParams = parsedSegment.data.parameters;

      Object.assign(filters, filtersArrayToObject(segmentParams.filters ?? []));

      if (segmentParams.match) {
        match = segmentParams.match;
      }
    }

    if (params.cohort) {
      const cohort = await getWebsiteSegment(websiteId, params.cohort);
      const parsedCohort = savedSegmentSchema.safeParse(cohort);

      if (!parsedCohort.success || parsedCohort.data.type !== 'cohort') {
        throw new Error('INVALID_SAVED_COHORT');
      }

      const cohortParams = parsedCohort.data.parameters;

      const { startDate, endDate } = parseDateRange(cohortParams.dateRange);

      const cohortFilters = (cohortParams.filters ?? []).map(({ name, ...props }) => ({
        ...props,
        name: `cohort_${name}`,
      }));

      cohortFilters.push({
        name: `cohort_${cohortParams.action.type}`,
        operator: OPERATORS.equals,
        value: cohortParams.action.value,
      });

      Object.assign(filters, {
        ...filtersArrayToObject(cohortFilters),
        cohort_startDate: startDate,
        cohort_endDate: endDate,
        ...(cohortParams.match && {
          cohort_match: cohortParams.match,
          cohort_actionName: `cohort_${cohortParams.action.type}`,
        }),
      });
    }

    if (params.excludeBounce) {
      Object.assign(filters, { excludeBounce: true });
    }
  }

  return {
    ...dateRange,
    ...filters,
    match,
    minDuration: params?.minDuration,
    page: params?.page,
    pageSize: params?.pageSize ? params?.pageSize || DEFAULT_PAGE_SIZE : undefined,
    orderBy: params?.orderBy,
    sortDescending: params?.sortDescending,
    search: params?.search,
    compare: params?.compare,
    trafficType: params?.trafficType,
    maxResults: params?.maxResults,
  };
}
