import clickhouse, { isClickHouseDiscoveryLimitError } from '@/lib/clickhouse';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import {
  LINKED_QUERY_TIMEOUT_MS,
  MAX_AUTH_SESSION_ROWS,
  MAX_LINK_READ_ROWS,
} from '@/lib/share-query-budget';

export async function queryVerifiedIdentityEvents<Row>(
  query: string,
  params: Record<string, unknown>,
  functionName: string,
): Promise<Row[]> {
  let rows: Row[];

  try {
    rows = await clickhouse.rawQuery<Row[]>(
      query,
      { ...params, rowLimit: MAX_AUTH_SESSION_ROWS + 1 },
      functionName,
      {
        maxExecutionTimeSeconds: LINKED_QUERY_TIMEOUT_MS / 1000,
        maxResultRows: MAX_AUTH_SESSION_ROWS + 1,
        maxRowsToRead: MAX_LINK_READ_ROWS,
        maxRowsToGroupBy: MAX_AUTH_SESSION_ROWS + 1,
        maxThreads: 1,
      },
    );
  } catch (error) {
    if (isClickHouseDiscoveryLimitError(error)) {
      throw new IdentitySearchTooBroadError();
    }
    throw error;
  }

  if (rows.length > MAX_AUTH_SESSION_ROWS) {
    throw new IdentitySearchTooBroadError();
  }

  return rows;
}
