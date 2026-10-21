import { z } from 'zod';
import { filterParams, withDateRange } from '@/lib/schema';

export const revenueStatsQuerySchema = withDateRange({
  currency: z.string(),
  ...filterParams,
});
