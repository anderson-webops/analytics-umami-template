import type { Prisma } from '@/generated/prisma/client';
import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TRUST_TIER, DATA_TYPE, FIELD_LENGTH } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { flattenJSON, getStoredStringValue } from '@/lib/data';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import { truncateString } from '@/lib/format';
import kafka from '@/lib/kafka';
import prisma from '@/lib/prisma';
import { hasRevenueField } from '@/lib/revenue-provenance';
import type { DynamicData } from '@/lib/types';

export interface SaveSessionDataArgs {
  websiteId: string;
  sessionId: string;
  sessionData: DynamicData;
  trustTier: typeof COLLECTION_TRUST_TIER.backendAuthorized;
  distinctId?: string;
  createdAt?: Date;
}

function assertSessionDataProvenance(data: SaveSessionDataArgs) {
  if (data.trustTier !== COLLECTION_TRUST_TIER.backendAuthorized) {
    throw new Error('Session property provenance is required.');
  }

  if (hasRevenueField(data.sessionData)) {
    throw new Error('Verified revenue collection is not enabled.');
  }
}

export async function saveSessionData(
  data: SaveSessionDataArgs,
  transaction?: Prisma.TransactionClient,
) {
  assertSessionDataProvenance(data);

  if (transaction) {
    return relationalQuery(data, transaction);
  }

  return runQuery({
    [PRISMA]: () => relationalQuery(data),
    [CLICKHOUSE]: () => clickhouseQuery(data),
  });
}

export async function relationalQuery(
  data: SaveSessionDataArgs,
  transaction: Prisma.TransactionClient | typeof prisma.client = prisma.client,
) {
  assertSessionDataProvenance(data);
  const { websiteId, sessionId, sessionData, trustTier, distinctId, createdAt } = data;

  const normalizedDistinctId = truncateString(distinctId, FIELD_LENGTH.distinctId);
  const rows = new Map<string, Record<string, unknown>>();

  for (const entry of flattenJSON(sessionData)) {
    const dataKey = truncateString(entry.key, FIELD_LENGTH.dataKey);
    rows.set(dataKey, {
      session_data_id: uuid(),
      website_id: websiteId,
      session_id: sessionId,
      data_key: dataKey,
      string_value: getStoredStringValue(entry.value, entry.dataType),
      number_value: entry.dataType === DATA_TYPE.number ? entry.value : null,
      date_value: entry.dataType === DATA_TYPE.date ? new Date(entry.value) : null,
      data_type: entry.dataType,
      trust_tier: trustTier,
      distinct_id: normalizedDistinctId,
      created_at: createdAt,
    });
  }

  if (rows.size === 0) return;

  await transaction.$executeRaw`
    INSERT INTO "session_data" (
      "session_data_id", "website_id", "session_id", "data_key", "string_value",
      "number_value", "date_value", "data_type", "trust_tier", "distinct_id", "created_at"
    )
    SELECT
      data.session_data_id, data.website_id, data.session_id, data.data_key,
      data.string_value, data.number_value, data.date_value, data.data_type, data.trust_tier,
      data.distinct_id, COALESCE(data.created_at, now())
    FROM jsonb_to_recordset(${JSON.stringify([...rows.values()])}::jsonb) AS data (
      session_data_id uuid, website_id uuid, session_id uuid, data_key varchar(500),
      string_value varchar(500), number_value numeric(19, 4), date_value timestamptz,
      data_type integer, trust_tier smallint, distinct_id varchar(50), created_at timestamptz
    )
    ON CONFLICT ("session_id", "data_key") DO UPDATE SET
      "website_id" = EXCLUDED."website_id",
      "string_value" = EXCLUDED."string_value",
      "number_value" = EXCLUDED."number_value",
      "date_value" = EXCLUDED."date_value",
      "data_type" = EXCLUDED."data_type",
      "trust_tier" = EXCLUDED."trust_tier",
      "distinct_id" = CASE WHEN ${distinctId !== undefined}
        THEN EXCLUDED."distinct_id" ELSE "session_data"."distinct_id" END,
      "created_at" = CASE WHEN ${createdAt !== undefined}
        THEN EXCLUDED."created_at" ELSE "session_data"."created_at" END
  `;
}

async function clickhouseQuery(data: SaveSessionDataArgs) {
  assertSessionDataProvenance(data);
  const { websiteId, sessionId, sessionData, trustTier, distinctId, createdAt } = data;

  const { insert, getUTCString } = clickhouse;
  const { sendMessage } = kafka;

  const jsonKeys = flattenJSON(sessionData);
  const normalizedDistinctId = truncateString(distinctId, FIELD_LENGTH.distinctId);

  const messages = jsonKeys.map(({ key, value, dataType }) => {
    return {
      website_id: websiteId,
      session_id: sessionId,
      data_key: truncateString(key, FIELD_LENGTH.dataKey),
      data_type: dataType,
      trust_tier: trustTier,
      string_value: getStoredStringValue(value, dataType),
      number_value: dataType === DATA_TYPE.number ? value : null,
      date_value: dataType === DATA_TYPE.date ? getUTCString(value) : null,
      distinct_id: normalizedDistinctId,
      created_at: getUTCString(createdAt),
    };
  });

  if (kafka.enabled) {
    await sendMessage('session_data', messages);
  } else {
    await insert('session_data', messages);
  }
}
