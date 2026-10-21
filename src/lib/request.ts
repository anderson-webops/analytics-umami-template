import { startOfMonth, subMonths } from 'date-fns';
import { z } from 'zod';
import { getCanonicalApiPath } from '@/lib/api-key';
import { checkAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, FILTER_COLUMNS, OPERATORS } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import {
  getAllowedUnits,
  getCompareDate,
  getMinimumUnit,
  maxDate,
  parseDateRange,
} from '@/lib/date';
import { isEnvEnabled } from '@/lib/env';
import { fetchAccount, fetchWebsite } from '@/lib/load';
import {
  filtersArrayToObject,
  parseSessionPropertyFilters,
  parseUniversalEventPropertyFilters,
} from '@/lib/params';
import { getTenantQueryIdentity } from '@/lib/query-admission';
import { reserveAuthenticatedQueryLease } from '@/lib/query-concurrency';
import { getJsonBody, RequestBodyTooLargeError } from '@/lib/request-body';
import { releaseAfterResponse } from '@/lib/request-lifecycle';
import {
  badRequest,
  forbidden,
  payloadTooLarge,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import { savedSegmentSchema } from '@/lib/schema';
import type { ShareSection } from '@/lib/share';
import { hasShareFilterParams } from '@/lib/share-filter';
import {
  getAuthenticatedQueryCost,
  getShareQueryCost,
  getStepFilterCount,
  isSavedSegmentWithinQueryBudget,
  MAX_SHARE_COUNT_RESULTS,
  reserveAuthenticatedQueryCost,
  reserveShareQueryCost,
  reserveTenantQueryCost,
  type ShareQueryWorkMultiplier,
} from '@/lib/share-query-budget';
import type { QueryFilters, SessionPropertyFilter } from '@/lib/types';
import { canViewWebsite, canViewWebsiteSection } from '@/permissions';
import { getWebsiteSegment } from '@/queries/prisma';

const MAX_QUERY_DATE_RANGE_MS = 20 * 366 * 24 * 60 * 60 * 1000;
const MAX_API_URL_BYTES = 16 * 1024;
const MAX_API_QUERY_PARAMETERS = 200;
const MAX_REPORT_FILTER_PARAMETERS = 100;
const MAX_REPORT_FILTER_KEY_LENGTH = 128;
const MAX_REPORT_FILTER_VALUE_LENGTH = 500;
const SAVED_COHORT_SNAPSHOT = Symbol('saved-cohort-snapshot');

async function getSavedCohortRange(
  query: Record<string, any>,
  body: unknown,
  websiteId: string,
): Promise<number | null> {
  const reportFilters =
    body && typeof body === 'object' && 'filters' in body && body.filters
      ? (body.filters as Record<string, any>)
      : null;
  let duration = 0;

  for (const values of [query, reportFilters]) {
    if (!values || typeof values.cohort !== 'string') continue;

    const cohort = await getWebsiteSegment(websiteId, values.cohort);
    const parsed = savedSegmentSchema.safeParse(cohort);

    if (!parsed.success || parsed.data.type !== 'cohort') return null;
    if (
      !isSavedSegmentWithinQueryBudget(
        parsed.data.parameters.filters ?? [],
        [],
        parsed.data.parameters.action.type,
      )
    )
      return null;

    let range: ReturnType<typeof parseDateRange>;

    try {
      range = parseDateRange(parsed.data.parameters.dateRange);
    } catch {
      return null;
    }

    const rangeMs = range ? +range.endDate - +range.startDate : NaN;
    if (!Number.isFinite(rangeMs) || rangeMs < 0 || rangeMs > MAX_QUERY_DATE_RANGE_MS) {
      return null;
    }

    Object.defineProperty(values, SAVED_COHORT_SNAPSHOT, {
      configurable: true,
      enumerable: true,
      value: { websiteId, cohortId: values.cohort, cohort: parsed.data },
    });
    duration = Math.max(duration, rangeMs);
  }

  return duration;
}

function getQueryWebsiteId(pathname: string, body: unknown, configuredWebsiteId?: string) {
  const canonical = getCanonicalApiPath(pathname);
  const routeWebsiteId = /^\/api\/(?:websites|realtime)\/([^/]+)(?:\/|$)/.exec(canonical)?.[1];
  const bodyWebsiteId =
    /^\/(?:compat\/)?api\/reports\/[^/]+\/?$/.test(canonical) &&
    body &&
    typeof body === 'object' &&
    'websiteId' in body
      ? body.websiteId
      : undefined;
  const websiteId = configuredWebsiteId ?? routeWebsiteId ?? bodyWebsiteId;

  return typeof websiteId === 'string' && isUuid(websiteId) ? websiteId : null;
}

function hasBoundedReportFilters(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return true;

  const filters = (body as { filters?: unknown }).filters;

  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return true;

  const entries = Object.entries(filters);

  return (
    entries.length <= MAX_REPORT_FILTER_PARAMETERS &&
    entries.every(
      ([key, value]) =>
        key.length <= MAX_REPORT_FILTER_KEY_LENGTH &&
        (typeof value !== 'string' || value.length <= MAX_REPORT_FILTER_VALUE_LENGTH),
    )
  );
}

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
  options?: {
    skipAuth?: boolean;
    maxBodyBytes?: number;
    bodyPreflight?: (body: unknown) => boolean;
    budgetShareQuery?: boolean;
    capShareCount?: boolean;
    shareQueryContext?: { section: ShareSection; websiteId?: string };
    shareQueryWorkMultiplier?:
      | ShareQueryWorkMultiplier
      | ((query: Record<string, any>, body: unknown) => ShareQueryWorkMultiplier | null);
    authenticatedQueryFanout?: number;
    allowShareSearch?: boolean;
  },
): Promise<any> {
  const url = new URL(request.url);
  const isCompatibilityReport =
    request.method.toUpperCase() === 'POST' &&
    /^\/(?:compat\/)?api\/reports\/[^/]+\/?$/.test(getCanonicalApiPath(url.pathname));
  let query: Record<string, any> = {};
  let body: unknown;
  let error: () => undefined | undefined | Response;
  let auth = null;
  let admittedMinimumRangeMs = 0;

  if (
    Buffer.byteLength(request.url, 'utf8') > MAX_API_URL_BYTES ||
    url.searchParams.size > MAX_API_QUERY_PARAMETERS
  ) {
    error = () =>
      badRequest({
        message: 'The request URL has too many or oversized query parameters.',
      });
  } else {
    query = Object.fromEntries(url.searchParams);
  }

  if (!options?.skipAuth && !error) {
    auth = await checkAuth(request);

    if (!auth) {
      error = () => unauthorized();
    }
  }

  if (!['GET', 'HEAD'].includes(request.method.toUpperCase()) && !error) {
    try {
      body = await getJsonBody(request, options?.maxBodyBytes);
    } catch (cause) {
      if (cause instanceof RequestBodyTooLargeError) {
        error = () => payloadTooLarge();
      }
    }
  }

  if (!error && isCompatibilityReport && !hasBoundedReportFilters(body)) {
    error = () => badRequest({ message: 'Too many or oversized filter parameters.' });
  }

  if (!error && options?.bodyPreflight && !options.bodyPreflight(body)) {
    error = () => badRequest({ message: 'Invalid request body.' });
  }

  if (schema && !error) {
    const isGet = ['GET', 'HEAD'].includes(request.method.toUpperCase());
    const rawQuery = query;
    const result = schema.safeParse(isGet ? query : body);

    if (!result.success) {
      let issueTextLength = 0;
      const hasBoundedIssues =
        result.error.issues.length <= 64 &&
        result.error.issues.every(issue => {
          issueTextLength += issue.message.length;

          for (const part of issue.path) {
            const length = String(part).length;

            if (length > 128) {
              return false;
            }

            issueTextLength += length;
          }

          return issue.message.length <= 512 && issueTextLength <= 4096;
        });
      error = () =>
        badRequest(
          hasBoundedIssues ? z.treeifyError(result.error) : { message: 'Invalid request body.' },
        );
    } else if (isGet) {
      query = result.data;

      // Re-add dynamic filter params stripped by the route schema, while
      // bounding their count, key size, and value size.
      let dynamicFilterCount = 0;

      for (const key of Object.keys(rawQuery)) {
        const baseName = key.replace(/\d+$/, '');
        const isSuffixedFilter = /\d+$/.test(key) && Object.hasOwn(FILTER_COLUMNS, baseName);
        const isPropertyFilter = /^pf_[A-Za-z0-9_-]+$/.test(key);
        const isUniversalPropertyFilter = /^(?:epf|spf)\d+$/.test(key);

        if (
          (isSuffixedFilter || isPropertyFilter || isUniversalPropertyFilter) &&
          !(key in query)
        ) {
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
    const bodyParameters =
      body && typeof body === 'object' && !Array.isArray(body) && 'parameters' in body
        ? (body as { parameters?: { steps?: unknown } }).parameters
        : undefined;

    if (
      hasShareFilterParams(
        query,
        options?.allowShareSearch === true && ['path', 'event'].includes(query.type),
      ) ||
      hasBodyFilters ||
      getStepFilterCount(query.steps) > 0 ||
      getStepFilterCount(bodyParameters?.steps) > 0
    ) {
      error = () =>
        forbidden({
          message: 'Filters are disabled for this public share.',
          code: 'share-filters-disabled',
        });
    }
  }

  const hasQueryRange =
    (query.startAt != null && query.endAt != null) ||
    (query.startDate != null && query.endDate != null);
  const bodyParameters =
    body && typeof body === 'object' && !Array.isArray(body) && 'parameters' in body
      ? (body as { parameters?: { startDate?: unknown; endDate?: unknown } }).parameters
      : undefined;
  const hasBodyRange = bodyParameters?.startDate != null && bodyParameters.endDate != null;

  if (!error && auth?.shareToken && options?.capShareCount) {
    const maxResults = Math.min(
      query.maxResults ?? MAX_SHARE_COUNT_RESULTS,
      MAX_SHARE_COUNT_RESULTS,
    );
    if ((query.page ?? 1) * (query.pageSize ?? DEFAULT_PAGE_SIZE) > maxResults) {
      error = () => badRequest({ message: 'The public-share page exceeds the count limit.' });
    } else {
      query.maxResults = maxResults;
    }
  }

  if (!error && auth?.shareToken && options?.shareQueryContext) {
    const websiteId =
      options.shareQueryContext.websiteId ??
      (body && typeof body === 'object' && 'websiteId' in body ? body.websiteId : undefined);

    if (
      typeof websiteId !== 'string' ||
      !(await canViewWebsiteSection(auth, websiteId, options.shareQueryContext.section))
    ) {
      error = () => unauthorized();
    }
  }

  if (!error && auth?.shareToken && options?.budgetShareQuery && !schema) {
    error = () => badRequest({ message: 'The public-share query is too complex.' });
  }

  if (
    !error &&
    auth?.shareToken &&
    schema &&
    (hasQueryRange || hasBodyRange || options?.budgetShareQuery)
  ) {
    const workMultiplier =
      typeof options?.shareQueryWorkMultiplier === 'function'
        ? options.shareQueryWorkMultiplier(query, body)
        : (options?.shareQueryWorkMultiplier ?? 1);
    const budget = getShareQueryCost(query, body, workMultiplier);

    if (budget === null) {
      error = () => badRequest({ message: 'The public-share query is too complex.' });
    } else {
      const shareId =
        auth.shareToken.shareId ??
        auth.shareToken.websiteId ??
        auth.shareToken.boardId ??
        auth.shareToken.pixelId ??
        auth.shareToken.linkId;

      if (!shareId) {
        error = () => unauthorized();
      } else {
        const limit = await reserveShareQueryCost(shareId, budget.charge, request);

        if (limit.unavailable) {
          error = () => serviceUnavailable();
        } else if (limit.blocked) {
          error = () => tooManyRequests(limit.retryAfter);
        }
      }
    }
  }

  const method = request.method.toUpperCase();
  const isAuthenticatedAnalyticsRead =
    ['GET', 'HEAD'].includes(method) && (hasQueryRange || options?.budgetShareQuery);
  const isAuthenticatedReport = isCompatibilityReport && hasBodyRange;

  if (
    !error &&
    auth?.user?.id &&
    schema &&
    (isAuthenticatedAnalyticsRead || isAuthenticatedReport)
  ) {
    const workMultiplier =
      typeof options?.shareQueryWorkMultiplier === 'function'
        ? options.shareQueryWorkMultiplier(query, body)
        : (options?.shareQueryWorkMultiplier ?? 1);
    let budget = getAuthenticatedQueryCost(query, body, workMultiplier);

    if (budget === null) {
      error = () => badRequest({ message: 'The analytics query is too complex.' });
    } else {
      const websiteId = getQueryWebsiteId(
        url.pathname,
        body,
        options?.shareQueryContext?.websiteId,
      );
      const authorizedWebsiteId =
        websiteId && (await canViewWebsite({ user: auth.user }, websiteId)) ? websiteId : null;
      let tenantId: string | null = null;

      if (authorizedWebsiteId) {
        try {
          tenantId = await getTenantQueryIdentity(authorizedWebsiteId);
          const cohortRange = await getSavedCohortRange(query, body, authorizedWebsiteId);

          if (cohortRange === null) {
            error = () => badRequest({ message: 'The analytics query is too complex.' });
          } else {
            admittedMinimumRangeMs = cohortRange;
            budget = getAuthenticatedQueryCost(query, body, workMultiplier, cohortRange);
            if (budget === null) {
              error = () => badRequest({ message: 'The analytics query is too complex.' });
            }
          }
        } catch {
          error = () => serviceUnavailable();
        }

        if (!tenantId) error = () => serviceUnavailable();
      }

      if (!error && budget) {
        const limit = await reserveAuthenticatedQueryCost(auth.user.id, budget.charge);

        if (limit.unavailable) {
          error = () => serviceUnavailable();
        } else if (limit.blocked) {
          error = () => tooManyRequests(limit.retryAfter);
        } else {
          const lease = await reserveAuthenticatedQueryLease(
            auth.user.id,
            tenantId,
            budget.charge,
            options?.authenticatedQueryFanout,
          );

          if (lease && !('release' in lease)) {
            error = lease.unavailable
              ? () => serviceUnavailable()
              : () => tooManyRequests(lease.retryAfter);
          } else if (lease && 'release' in lease) {
            let releaseScheduled = false;

            try {
              if (tenantId) {
                const tenantLimit = await reserveTenantQueryCost(tenantId, budget.charge);

                if (tenantLimit.unavailable) {
                  error = () => serviceUnavailable();
                } else if (tenantLimit.blocked) {
                  error = () => tooManyRequests(tenantLimit.retryAfter);
                }
              }

              if (!error) {
                try {
                  releaseAfterResponse(lease.release);
                  releaseScheduled = true;
                } catch {
                  error = () => serviceUnavailable();
                }
              }
            } finally {
              if (!releaseScheduled) await lease.release();
            }
          }
        }
      }
    }
  }

  return { url, query, body, auth, error, admittedMinimumRangeMs };
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
    if (Object.hasOwn(FILTER_COLUMNS, baseName)) {
      result[key] = query[key];
    }
  }

  return result;
}

export async function setWebsiteDate<T extends object>(websiteId: string, data: T): Promise<T> {
  const datedData = data as T & { startDate?: Date };
  const website = await fetchWebsite(websiteId);
  const cloudMode = isEnvEnabled('CLOUD_MODE');

  if (cloudMode && website && !website.teamId) {
    const account = await fetchAccount(website.userId);

    if (!account?.hasSubscription) {
      datedData.startDate = maxDate(datedData.startDate, startOfMonth(subMonths(new Date(), 6)));
    }
  }

  if (website?.resetAt) {
    datedData.startDate = maxDate(datedData.startDate, new Date(website?.resetAt));
  }

  return data;
}

export async function getBoundedCompareDate(
  websiteId: string,
  compare: string,
  startDate: Date,
  endDate: Date,
) {
  const comparison = getCompareDate(compare, startDate, endDate);

  if (!comparison.startDate || !comparison.endDate) {
    throw new Error('INVALID_COMPARE_PERIOD');
  }

  return setWebsiteDate(websiteId, {
    compare,
    startDate: comparison.startDate,
    endDate: comparison.endDate,
  });
}

export async function getQueryFilters(
  params: Record<string, any>,
  websiteId?: string,
): Promise<QueryFilters> {
  const dateRange = getRequestDateRange(params);
  const filters = getRequestFilters(params);
  const eventPropertyFilters = parseUniversalEventPropertyFilters(params);
  const sessionPropertyFilters = parseSessionPropertyFilters(params);

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

      if (
        !isSavedSegmentWithinQueryBudget(
          segmentParams.filters ?? [],
          segmentParams.sessionPropertyFilters ?? [],
        )
      ) {
        throw new Error('INVALID_SAVED_SEGMENT');
      }

      Object.assign(filters, filtersArrayToObject(segmentParams.filters ?? []));
      sessionPropertyFilters.push(
        ...((segmentParams.sessionPropertyFilters ?? []) as SessionPropertyFilter[]),
      );

      if (segmentParams.match) {
        match = segmentParams.match;
      }
    }

    if (params.cohort) {
      const snapshot = Reflect.get(params, SAVED_COHORT_SNAPSHOT);
      const cohort =
        snapshot?.websiteId === websiteId && snapshot.cohortId === params.cohort
          ? snapshot.cohort
          : await getWebsiteSegment(websiteId, params.cohort);
      const parsedCohort = savedSegmentSchema.safeParse(cohort);

      if (!parsedCohort.success || parsedCohort.data.type !== 'cohort') {
        throw new Error('INVALID_SAVED_COHORT');
      }

      const cohortParams = parsedCohort.data.parameters;

      if (
        !isSavedSegmentWithinQueryBudget(cohortParams.filters ?? [], [], cohortParams.action.type)
      ) {
        throw new Error('INVALID_SAVED_COHORT');
      }

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
    eventPropertyFilters,
    sessionPropertyFilters,
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
