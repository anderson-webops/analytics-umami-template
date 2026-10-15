import clickhouse, { isClickHouseDiscoveryLimitError } from '@/lib/clickhouse';
import prisma from '@/lib/prisma';
import { DiscoveryRangeTooBroadError } from './discoveryError';

const MAX_DISCOVERY_INPUT_ROWS = 50_000;
const MAX_DISCOVERY_RESULT_ROWS = 500;

export async function boundedPostgresDiscovery<T>(
  rowsQuery: string,
  resultQuery: string,
  resultOrder: string,
  queryParams: Record<string, unknown>,
  functionName: string,
  maxResultRows = MAX_DISCOVERY_RESULT_ROWS,
): Promise<T[]> {
  if (
    !Number.isSafeInteger(maxResultRows) ||
    maxResultRows < 1 ||
    maxResultRows > MAX_DISCOVERY_RESULT_ROWS
  ) {
    throw new Error('Invalid discovery result limit.');
  }

  const response = await prisma.rawQuery(
    `
    with bounded as materialized (
      ${rowsQuery}
      limit ${MAX_DISCOVERY_INPUT_ROWS + 1}
    ), admission as materialized (
      select count(*) as row_count from bounded
    ), admitted as materialized (
      select * from bounded
      where (select row_count from admission) <= ${MAX_DISCOVERY_INPUT_ROWS}
    )
    select
      row_count > ${MAX_DISCOVERY_INPUT_ROWS} as "budgetExceeded",
      case when row_count > ${MAX_DISCOVERY_INPUT_ROWS} then '[]'::json
        else (
          select coalesce(json_agg(row_to_json(result) order by ${resultOrder}), '[]'::json)
          from (
            ${resultQuery}
            limit {{discoveryResultLimit}}
          ) result
        )
      end as rows
    from admission
    `,
    { ...queryParams, discoveryResultLimit: maxResultRows },
    functionName,
  );

  if (response.length !== 1 || response[0].budgetExceeded) {
    throw new DiscoveryRangeTooBroadError();
  }

  return response[0].rows as T[];
}

export async function boundedClickhouseDiscovery<T>(
  query: string,
  queryParams: Record<string, unknown>,
  functionName: string,
): Promise<T[]> {
  try {
    return await clickhouse.rawQuery<T[]>(query, queryParams, functionName, {
      maxRowsToGroupBy: MAX_DISCOVERY_INPUT_ROWS,
      maxRowsInJoin: MAX_DISCOVERY_INPUT_ROWS,
      maxThreads: 1,
    });
  } catch (error) {
    if (isClickHouseDiscoveryLimitError(error)) {
      throw new DiscoveryRangeTooBroadError();
    }

    throw error;
  }
}
