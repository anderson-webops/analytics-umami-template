import { z } from 'zod';
import { isoTimestamp, parseDateRange, toIso } from '../lib/dates';
import { McpToolError } from '../lib/errors';
import { filtersSchema, toFilterParams } from '../lib/filters';
import { clamp, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageInfo } from '../lib/limits';
import { defineTool } from '../lib/tool';

const MAX_GOAL_STATS_PAGE_SIZE = 20;
const MAX_CONCURRENT_GOAL_STATS = 4;
const MAX_GOAL_STATS_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

interface GoalRow {
  id?: string;
  name?: string;
  description?: string;
  parameters?: { type?: string; value?: string } | null;
  createdAt?: string | null;
}

interface GoalStats {
  num?: number;
  total?: number;
}

async function mapInBatches<Input, Output>(
  items: Input[],
  batchSize: number,
  transform: (item: Input) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = [];

  for (let offset = 0; offset < items.length; offset += batchSize) {
    results.push(...(await Promise.all(items.slice(offset, offset + batchSize).map(transform))));
  }

  return results;
}

export const getGoals = defineTool({
  name: 'get_goals',
  title: 'Get saved goals',
  description:
    'Lists the goals saved for a website (a goal is a target page path or custom event, e.g. "visit /thank-you" or ' +
    '"fire signup"). Pass startAt (and optionally endAt) to also compute each goal\'s results in that range: how many ' +
    'visitors converted, the total visitors, and the conversion rate. Use "goalId" to check a single goal. ' +
    'Statistics are limited to 20 goals per page and a 366-day range; paginate or narrow the range for larger reports. ' +
    'Use this for "how are we doing against our goals?" questions. Requires a websiteId from list_websites.',
  inputSchema: z.object({
    websiteId: z.string().uuid().describe('Website ID from list_websites.'),
    goalId: z.string().uuid().optional().describe('Only return this goal.'),
    startAt: isoTimestamp
      .optional()
      .describe('Start of the range for goal results. Omit to only list goals.'),
    endAt: isoTimestamp.optional().describe('End of the range (inclusive). Defaults to now.'),
    search: z.string().optional().describe('Filter goals by name or description.'),
    page: z.number().int().positive().optional().describe('Page number, starting at 1.'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe(`Results per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`),
    filters: filtersSchema.optional(),
  }),
  async handler(input, { client }) {
    const range = input.startAt
      ? parseDateRange({ startAt: input.startAt, endAt: input.endAt })
      : null;
    const pageSize = clamp(input.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    if (range && range.endAt - range.startAt > MAX_GOAL_STATS_RANGE_MS) {
      throw new McpToolError('invalid_date_range', 'Goal statistics are limited to 366 days.');
    }

    if (range && !input.goalId && pageSize > MAX_GOAL_STATS_PAGE_SIZE) {
      throw new McpToolError('invalid_input', 'Goal statistics are limited to 20 goals per page.');
    }

    const result = (await client.getWebsiteGoals({
      websiteId: input.websiteId,
      search: input.search,
      page: input.page ?? 1,
      pageSize,
    })) as { data?: GoalRow[]; count?: number; page?: number; pageSize?: number };

    const rows = (result?.data ?? []).filter(row => !input.goalId || row.id === input.goalId);

    if (range && rows.length > MAX_GOAL_STATS_PAGE_SIZE) {
      throw new McpToolError('invalid_input', 'Goal statistics are limited to 20 goals per page.');
    }

    const filters = toFilterParams(input.filters);

    const goals = await mapInBatches(rows, MAX_CONCURRENT_GOAL_STATS, async row => {
      const goal = {
        id: row.id,
        name: row.name,
        description: row.description || null,
        type: row.parameters?.type ?? null,
        value: row.parameters?.value ?? null,
        createdAt: toIso(row.createdAt),
      };

      if (!range || !row.id) {
        return goal;
      }

      const stats = (await client.getWebsiteSavedGoalStats({
        websiteId: input.websiteId,
        goalId: row.id,
        startAt: range.startAt,
        endAt: range.endAt,
        ...filters,
      })) as GoalStats;
      const conversions = Number(stats?.num ?? 0);
      const visitors = Number(stats?.total ?? 0);

      return {
        ...goal,
        results: {
          conversions,
          visitors,
          conversionRate: visitors ? Math.round((conversions / visitors) * 1000) / 10 : 0,
        },
      };
    });

    return {
      websiteId: input.websiteId,
      ...(range
        ? {
            range: {
              startAt: new Date(range.startAt).toISOString(),
              endAt: new Date(range.endAt).toISOString(),
            },
          }
        : {}),
      goals,
      ...pageInfo(result ?? {}),
    };
  },
});
