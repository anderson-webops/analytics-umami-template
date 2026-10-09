import { z } from 'zod';
import { filterParams, withDateRange } from '@/lib/schema';

export const revenueMetricsQuerySchema = withDateRange({
  type: z.enum(['country', 'region', 'referrer', 'channel']),
  currency: z.string(),
  limit: z.coerce.number().int().positive().max(10).optional(),
  ...filterParams,
});
