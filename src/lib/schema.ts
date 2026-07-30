import { z } from 'zod';
import { isValidTimezone, normalizeTimezone } from '@/lib/date';
import { isAcceptableLoginPassword, isStrongPassword } from '@/lib/password';
import { isSafeHttpsUrl, isSafeHttpUrl } from '@/lib/security';
import { DATETIME_REGEX, DOMAIN_REGEX, ENTITY_TYPE, UNIT_TYPES } from './constants';

export const timezoneParam = z
  .string()
  .refine((value: string) => isValidTimezone(value), {
    message: 'Invalid timezone',
  })
  .transform((value: string) => normalizeTimezone(value));

export const unitParam = z.string().refine(value => UNIT_TYPES.includes(value), {
  message: 'Invalid unit',
});

export const dateRangeParams = {
  startAt: z.coerce.number().finite().optional(),
  endAt: z.coerce.number().finite().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  timezone: timezoneParam.optional(),
  unit: unitParam.optional(),
  compare: z.enum(['prev', 'yoy']).optional(),
};

export function withDateRange<T extends z.ZodRawShape>(shape?: T) {
  return z
    .object({
      ...dateRangeParams,
      ...shape,
    })
    .superRefine((data: Record<string, unknown>, ctx) => {
      const hasTimestamps = data.startAt != null && data.endAt != null;
      const hasDates = data.startDate != null && data.endDate != null;

      if (!hasTimestamps && !hasDates) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Either startAt+endAt or startDate+endDate must be provided',
        });
        return;
      }

      const start = hasTimestamps ? Number(data.startAt) : (data.startDate as Date).getTime();
      const end = hasTimestamps ? Number(data.endAt) : (data.endDate as Date).getTime();
      const maxRange = 20 * 366 * 24 * 60 * 60 * 1000;

      if (start > end || end - start > maxRange) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The requested date range is invalid or exceeds 20 years.',
        });
      }
    });
}

export const filterParams = {
  path: z.string().max(500).optional(),
  referrer: z.string().max(500).optional(),
  title: z.string().max(500).optional(),
  query: z.string().max(500).optional(),
  os: z.string().max(500).optional(),
  browser: z.string().max(500).optional(),
  device: z.string().max(500).optional(),
  country: z.string().max(500).optional(),
  region: z.string().max(500).optional(),
  city: z.string().max(500).optional(),
  tag: z.string().max(500).optional(),
  hostname: z.string().max(500).optional(),
  distinctId: z.string().max(500).optional(),
  language: z.string().max(500).optional(),
  event: z.string().max(500).optional(),
  botName: z.string().max(500).optional(),
  botCategory: z.string().max(500).optional(),
  trafficType: z.enum(['human', 'bot', 'all']).optional(),
  utmSource: z.string().max(500).optional(),
  utmMedium: z.string().max(500).optional(),
  utmCampaign: z.string().max(500).optional(),
  utmContent: z.string().max(500).optional(),
  utmTerm: z.string().max(500).optional(),
  segment: z.uuid().optional(),
  cohort: z.uuid().optional(),
  eventType: z.coerce.number().int().positive().optional(),
  excludeBounce: z.string().optional(),
  match: z.enum(['all', 'any']).optional(),
};

export const searchParams = {
  search: z.string().max(200).optional(),
};

export const replayParams = {
  minDuration: z.coerce.number().int().nonnegative().max(31_536_000).optional(),
};

export const pagingParams = {
  page: z.coerce.number().int().positive().max(10_000).optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
  maxResults: z.coerce.number().int().positive().max(10_000).optional(),
};

export const queryLimitParam = z.coerce.number().int().positive().max(500);
export const queryOffsetParam = z.coerce.number().int().nonnegative().max(10_000);

export const sortingParams = {
  orderBy: z.string().max(100).optional(),
  sortDescending: z
    .enum(['true', 'false'])
    .optional()
    .transform(value => {
      if (value === undefined) {
        return undefined;
      }

      return value === 'true';
    }),
};

export const userRoleParam = z.enum(['admin', 'user', 'view-only']);

export const teamRoleParam = z.enum(['team-member', 'team-view-only', 'team-manager']);

export const loginPasswordParam = z
  .string()
  .max(72)
  .refine(isAcceptableLoginPassword, 'Password must not exceed 72 UTF-8 bytes.');

export const passwordParam = z
  .string()
  .min(12)
  .max(72)
  .refine(
    isStrongPassword,
    'Password must be at least 12 characters and no more than 72 UTF-8 bytes.',
  );

export const entityTypeParam = z.union([
  z.literal(ENTITY_TYPE.website),
  z.literal(ENTITY_TYPE.link),
  z.literal(ENTITY_TYPE.pixel),
  z.literal(ENTITY_TYPE.board),
]);

export const routeSlugParam = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'Slug may contain only letters, numbers, hyphens, and underscores.');

export const domainParam = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(DOMAIN_REGEX, 'Invalid website domain.');

export const shareParametersParam = z
  .object({
    allowFilter: z.boolean().optional(),
    theme: z.enum(['light', 'dark']).optional(),
    overview: z.boolean().optional(),
    events: z.boolean().optional(),
    sessions: z.boolean().optional(),
    realtime: z.boolean().optional(),
    performance: z.boolean().optional(),
    compare: z.boolean().optional(),
    breakdown: z.boolean().optional(),
    goals: z.boolean().optional(),
    funnels: z.boolean().optional(),
    journeys: z.boolean().optional(),
    retention: z.boolean().optional(),
    utm: z.boolean().optional(),
    revenue: z.boolean().optional(),
    attribution: z.boolean().optional(),
  })
  .strict();

const FORBIDDEN_DATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ANALYTICS_DATA_DEPTH = 5;
const MAX_ANALYTICS_DATA_PROPERTIES = 100;
const MAX_ANALYTICS_OBJECT_PROPERTIES = 50;
const MAX_ANALYTICS_ARRAY_ITEMS = 50;
const MAX_ANALYTICS_KEY_LENGTH = 90;
const MAX_ANALYTICS_STRING_LENGTH = 500;
const MAX_ANALYTICS_NUMBER = 999_999_999_999_999;
const MAX_GENERIC_DATA_DEPTH = 10;
const MAX_GENERIC_DATA_PROPERTIES = 2000;
const MAX_GENERIC_OBJECT_PROPERTIES = 250;
const MAX_GENERIC_ARRAY_ITEMS = 500;
const MAX_GENERIC_KEY_LENGTH = 128;
const MAX_GENERIC_STRING_LENGTH = 20_000;
const MAX_REPLAY_DATA_DEPTH = 256;
const MAX_REPLAY_DATA_PROPERTIES = 100_000;
const MAX_REPLAY_OBJECT_PROPERTIES = 50_000;
const MAX_REPLAY_ARRAY_ITEMS = 100_000;
const MAX_REPLAY_KEY_LENGTH = 1024;
const MAX_REPLAY_STRING_LENGTH = 1024 * 1024;

interface ObjectDataLimits {
  label: string;
  maxDepth: number;
  maxProperties: number;
  maxObjectProperties: number;
  maxArrayItems: number;
  maxKeyLength: number;
  maxStringLength: number;
}

function validateObjectData(
  root: Record<string, unknown>,
  limits: ObjectDataLimits,
): { valid: true } | { valid: false; message: string } {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let propertyCount = 0;

  while (stack.length > 0) {
    const { value, depth } = stack.pop();

    if (depth > limits.maxDepth) {
      return { valid: false, message: `${limits.label} is nested too deeply.` };
    }

    if (typeof value === 'string' && value.length > limits.maxStringLength) {
      return { valid: false, message: `${limits.label} contains an oversized string.` };
    }

    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { valid: false, message: `${limits.label} numbers must be finite.` };
    }

    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        return { valid: false, message: `${limits.label} contains an oversized array.` };
      }

      for (const item of value) {
        stack.push({ value: item, depth: depth + 1 });
      }

      continue;
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value);

      if (entries.length > limits.maxObjectProperties) {
        return { valid: false, message: `${limits.label} contains too many properties.` };
      }

      propertyCount += entries.length;

      if (propertyCount > limits.maxProperties) {
        return { valid: false, message: `${limits.label} contains too many total properties.` };
      }

      for (const [key, item] of entries) {
        if (key.length > limits.maxKeyLength || FORBIDDEN_DATA_KEYS.has(key)) {
          return { valid: false, message: `${limits.label} contains an invalid property name.` };
        }

        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }

  return { valid: true };
}

function validateGenericData(
  root: Record<string, unknown>,
): { valid: true } | { valid: false; message: string } {
  return validateObjectData(root, {
    label: 'Object data',
    maxDepth: MAX_GENERIC_DATA_DEPTH,
    maxProperties: MAX_GENERIC_DATA_PROPERTIES,
    maxObjectProperties: MAX_GENERIC_OBJECT_PROPERTIES,
    maxArrayItems: MAX_GENERIC_ARRAY_ITEMS,
    maxKeyLength: MAX_GENERIC_KEY_LENGTH,
    maxStringLength: MAX_GENERIC_STRING_LENGTH,
  });
}

function validateReplayData(
  root: Record<string, unknown>,
): { valid: true } | { valid: false; message: string } {
  return validateObjectData(root, {
    label: 'Replay data',
    maxDepth: MAX_REPLAY_DATA_DEPTH,
    maxProperties: MAX_REPLAY_DATA_PROPERTIES,
    maxObjectProperties: MAX_REPLAY_OBJECT_PROPERTIES,
    maxArrayItems: MAX_REPLAY_ARRAY_ITEMS,
    maxKeyLength: MAX_REPLAY_KEY_LENGTH,
    maxStringLength: MAX_REPLAY_STRING_LENGTH,
  });
}

export const anyObjectParam = z.record(z.string(), z.any()).superRefine((value, ctx) => {
  const result = validateGenericData(value);

  if (result.valid === false) {
    ctx.addIssue({
      code: 'custom',
      message: result.message,
    });
  }
});

export const replayObjectParam = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const result = validateReplayData(value);

  if (result.valid === false) {
    ctx.addIssue({
      code: 'custom',
      message: result.message,
    });
  }
});

const boardComponentParam = z
  .object({
    type: z.string().trim().min(1).max(100),
    entityType: z.enum(['website', 'pixel', 'link']).optional(),
    entityId: z.uuid().optional(),
    websiteId: z.uuid().optional(),
    title: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    props: anyObjectParam.optional(),
  })
  .strict();

const boardColumnParam = z
  .object({
    id: z.uuid(),
    component: boardComponentParam.nullable().optional(),
    size: z.number().finite().min(0).max(100).optional(),
  })
  .strict();

const boardRowParam = z
  .object({
    id: z.uuid(),
    columns: z.array(boardColumnParam).max(4),
    size: z.number().finite().min(0).max(100).optional(),
  })
  .strict();

export const boardParametersParam = z
  .object({
    websiteId: z.uuid().optional(),
    pixelId: z.uuid().optional(),
    linkId: z.uuid().optional(),
    rows: z.array(boardRowParam).max(50).optional(),
  })
  .strict();

function validateAnalyticsData(
  root: Record<string, unknown>,
): { valid: true } | { valid: false; message: string } {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let propertyCount = 0;

  while (stack.length > 0) {
    const { value, depth } = stack.pop();

    if (depth > MAX_ANALYTICS_DATA_DEPTH) {
      return { valid: false, message: 'Analytics data is nested too deeply.' };
    }

    if (typeof value === 'string' && value.length > MAX_ANALYTICS_STRING_LENGTH) {
      return { valid: false, message: 'Analytics data strings must not exceed 500 characters.' };
    }

    if (
      typeof value === 'string' &&
      DATETIME_REGEX.test(value) &&
      !Number.isFinite(Date.parse(value))
    ) {
      return { valid: false, message: 'Analytics data contains an invalid date.' };
    }

    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) || Math.abs(value) > MAX_ANALYTICS_NUMBER)
    ) {
      return {
        valid: false,
        message: 'Analytics data numbers exceed the supported database range.',
      };
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_ANALYTICS_ARRAY_ITEMS) {
        return { valid: false, message: 'Analytics data arrays must not exceed 50 items.' };
      }

      if (JSON.stringify(value).length > MAX_ANALYTICS_STRING_LENGTH) {
        return {
          valid: false,
          message: 'Serialized analytics arrays must not exceed 500 characters.',
        };
      }

      for (const item of value) {
        stack.push({ value: item, depth: depth + 1 });
      }

      continue;
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value);

      if (entries.length > MAX_ANALYTICS_OBJECT_PROPERTIES) {
        return {
          valid: false,
          message: 'Analytics data objects must not exceed 50 properties.',
        };
      }

      propertyCount += entries.length;

      if (propertyCount > MAX_ANALYTICS_DATA_PROPERTIES) {
        return {
          valid: false,
          message: 'Analytics data must not exceed 100 total properties.',
        };
      }

      for (const [key, item] of entries) {
        if (key.length > MAX_ANALYTICS_KEY_LENGTH || FORBIDDEN_DATA_KEYS.has(key)) {
          return { valid: false, message: 'Analytics data contains an invalid property name.' };
        }

        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }

  return { valid: true };
}

export const analyticsDataParam = anyObjectParam.superRefine((value, ctx) => {
  const result = validateAnalyticsData(value);

  if (result.valid === false) {
    ctx.addIssue({
      code: 'custom',
      message: result.message,
    });
  }
});

export const urlOrPathParam = z
  .string()
  .max(2_000)
  .refine(
    value => {
      try {
        const url = new URL(value, 'https://localhost');

        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.hostname.length <= 100 &&
          `${url.pathname}${url.hash}`.length <= 500 &&
          url.search.slice(1).length <= 500
        );
      } catch {
        return false;
      }
    },
    {
      message: 'Invalid or oversized URL.',
    },
  );

export const httpUrlParam = z
  .string()
  .max(500)
  .refine(isSafeHttpUrl, 'URL must use the http or https protocol.');

export const whiteLabelParam = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    domainName: z.string().max(500).refine(isSafeHttpsUrl, 'White-label domains must use HTTPS.'),
    logoUrl: z
      .string()
      .max(2_000)
      .refine(
        value => !value || isSafeHttpsUrl(value),
        'White-label logo URLs must be empty or use HTTPS.',
      ),
  })
  .strict();

export const fieldsParam = z.enum([
  'path',
  'referrer',
  'title',
  'query',
  'os',
  'browser',
  'device',
  'country',
  'region',
  'city',
  'tag',
  'hostname',
  'distinctId',
  'language',
  'event',
  'botName',
  'botCategory',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
]);

export const reportTypeParam = z.enum([
  'attribution',
  'breakdown',
  'funnel',
  'goal',
  'heatmap',
  'journey',
  'performance',
  'retention',
  'revenue',
  'utm',
]);

export const operatorParam = z.enum([
  'eq',
  'neq',
  's',
  'ns',
  'c',
  'dnc',
  're',
  'nre',
  't',
  'f',
  'gt',
  'lt',
  'gte',
  'lte',
  'bf',
  'af',
]);

export const goalReportSchema = z.object({
  type: z.literal('goal'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    type: z.string().trim().min(1).max(100),
    value: z.string().max(500),
  }),
});

export const funnelReportSchema = z.object({
  type: z.literal('funnel'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    window: z.coerce.number().int().positive().max(525_600),
    steps: z
      .array(
        z.object({
          type: z.enum(['path', 'event']),
          value: z.string().max(500),
          filters: z
            .array(
              z.object({
                property: z.string().min(1).max(100),
                operator: z.enum(['eq', 'neq', 'c', 'dnc']),
                value: z.string().max(500),
              }),
            )
            .max(20)
            .optional(),
        }),
      )
      .min(2)
      .max(8),
  }),
});

export const journeyReportSchema = z.object({
  type: z.literal('journey'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    steps: z.coerce.number().min(2).max(7),
    startStep: z.string().max(500).optional(),
    endStep: z.string().max(500).optional(),
    eventType: z.coerce.number().int().positive().optional(),
  }),
});

export const retentionReportSchema = z.object({
  type: z.literal('retention'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    timezone: timezoneParam.optional(),
  }),
});

export const utmReportSchema = z.object({
  type: z.literal('utm'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
  }),
});

export const performanceReportSchema = z.object({
  type: z.literal('performance'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    unit: unitParam.optional(),
    timezone: timezoneParam.optional(),
    metric: z.enum(['lcp', 'inp', 'cls', 'fcp', 'ttfb']).optional(),
  }),
});

export const revenueReportSchema = z.object({
  type: z.literal('revenue'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    unit: unitParam.optional(),
    timezone: timezoneParam.optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/, 'Currency must be a three-letter code.'),
    compare: z.enum(['prev', 'yoy']).optional(),
  }),
});

export const attributionReportSchema = z.object({
  type: z.literal('attribution'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    model: z.enum(['first-click', 'last-click']),
    type: z.enum(['path', 'event']),
    step: z.string().max(500),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, 'Currency must be a three-letter code.')
      .optional(),
  }),
});

export const breakdownReportSchema = z.object({
  type: z.literal('breakdown'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    fields: z.array(fieldsParam).min(1).max(20),
  }),
});

export const heatmapReportSchema = z.object({
  type: z.literal('heatmap'),
  parameters: z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    urlPath: z.string().max(500).optional(),
    mode: z.enum(['click', 'scroll']).optional(),
  }),
});

const reportMetadataSchema = z.object({
  websiteId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(500).optional(),
});

export const reportTypeSchema = z.discriminatedUnion('type', [
  goalReportSchema,
  funnelReportSchema,
  journeyReportSchema,
  performanceReportSchema,
  retentionReportSchema,
  utmReportSchema,
  revenueReportSchema,
  attributionReportSchema,
  breakdownReportSchema,
  heatmapReportSchema,
]);

function validateReportDateRange(
  data: { parameters?: { startDate?: Date; endDate?: Date } },
  ctx: z.RefinementCtx,
) {
  const start = data.parameters?.startDate?.getTime();
  const end = data.parameters?.endDate?.getTime();
  const maxRange = 20 * 366 * 24 * 60 * 60 * 1000;

  if (
    start == null ||
    end == null ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    end - start > maxRange
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The report date range is invalid or exceeds 20 years.',
      path: ['parameters'],
    });
  }
}

export const reportSchema = z
  .intersection(reportMetadataSchema, reportTypeSchema)
  .superRefine(validateReportDateRange);

export const reportResultSchema = z
  .intersection(
    z.object({
      websiteId: z.uuid(),
      filters: z.object({ ...filterParams }).passthrough(),
    }),
    reportTypeSchema,
  )
  .superRefine(validateReportDateRange);

export const segmentTypeParam = z.enum(['segment', 'cohort']);

const segmentFiltersParam = z
  .array(
    z
      .object({
        name: z.string().max(100),
        operator: operatorParam,
        value: z.string().max(500),
      })
      .strict(),
  )
  .max(50);

const segmentActionParam = z
  .object({
    type: z.string().trim().min(1).max(100),
    value: z.string().max(500),
  })
  .strict();

export const segmentParamSchema = z
  .object({
    filters: segmentFiltersParam.optional(),
    match: z.enum(['all', 'any']).optional(),
    dateRange: z.string().max(100).optional(),
    action: segmentActionParam.optional(),
  })
  .strict();

const savedSegmentNameParam = z.string().trim().min(1).max(200);

export const savedSegmentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('segment'),
      name: savedSegmentNameParam,
      parameters: z
        .object({
          filters: segmentFiltersParam.optional(),
          match: z.enum(['all', 'any']).optional(),
        })
        .strict(),
    })
    .strip(),
  z
    .object({
      type: z.literal('cohort'),
      name: savedSegmentNameParam,
      parameters: z
        .object({
          filters: segmentFiltersParam.optional(),
          match: z.enum(['all', 'any']).optional(),
          dateRange: z.string().trim().min(1).max(100),
          action: segmentActionParam,
        })
        .strict(),
    })
    .strip(),
]);
