import type { Prisma } from '@/generated/prisma/client';
import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TRUST_TIER, DATA_TYPE, FIELD_LENGTH } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { flattenJSON, getStoredStringValue } from '@/lib/data';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import { truncateString } from '@/lib/format';
import kafka from '@/lib/kafka';
import prisma from '@/lib/prisma';
import { hasRevenueField, isFinancialEventName } from '@/lib/revenue-provenance';
import type { DynamicData } from '@/lib/types';

export interface SaveEventDataArgs {
  websiteId: string;
  eventId: string;
  sessionId?: string;
  urlPath?: string;
  eventName?: string;
  eventData: DynamicData;
  trustTier: (typeof COLLECTION_TRUST_TIER)[keyof typeof COLLECTION_TRUST_TIER];
  createdAt?: Date;
}

export async function saveEventData(
  data: SaveEventDataArgs,
  transaction?: Prisma.TransactionClient | typeof prisma.client,
) {
  if (data.trustTier !== COLLECTION_TRUST_TIER.backendAuthorized) {
    throw new Error('Event properties require backend collection authorization.');
  }

  if (hasRevenueField(data.eventData, isFinancialEventName(data.eventName))) {
    throw new Error('Verified revenue collection is not enabled.');
  }

  if (transaction) {
    return relationalQuery(data, transaction);
  }

  return runQuery({
    [PRISMA]: () => relationalQuery(data),
    [CLICKHOUSE]: () => clickhouseQuery(data),
  });
}

async function relationalQuery(
  data: SaveEventDataArgs,
  transaction: Prisma.TransactionClient | typeof prisma.client = prisma.client,
) {
  const { websiteId, eventId, eventData, trustTier, createdAt } = data;

  const jsonKeys = flattenJSON(eventData);

  // id, websiteEventId, eventStringValue
  const flattenedData = jsonKeys.map(a => ({
    id: uuid(),
    websiteEventId: eventId,
    websiteId,
    dataKey: truncateString(a.key, FIELD_LENGTH.dataKey),
    stringValue: getStoredStringValue(a.value, a.dataType),
    numberValue: a.dataType === DATA_TYPE.number ? a.value : null,
    dateValue: a.dataType === DATA_TYPE.date ? new Date(a.value) : null,
    dataType: a.dataType,
    trustTier,
    createdAt,
  }));

  await transaction.eventData.createMany({
    data: flattenedData,
  });
}

async function clickhouseQuery(data: SaveEventDataArgs) {
  const { websiteId, sessionId, eventId, urlPath, eventName, eventData, trustTier, createdAt } =
    data;

  const { insert, getUTCString } = clickhouse;
  const { sendMessage } = kafka;

  const jsonKeys = flattenJSON(eventData);

  const messages = jsonKeys.map(({ key, value, dataType }) => {
    return {
      website_id: websiteId,
      session_id: sessionId,
      event_id: eventId,
      trust_tier: trustTier,
      url_path: truncateString(urlPath, FIELD_LENGTH.url),
      event_name: truncateString(eventName, FIELD_LENGTH.eventName),
      data_key: truncateString(key, FIELD_LENGTH.dataKey),
      data_type: dataType,
      string_value: getStoredStringValue(value, dataType),
      number_value: dataType === DATA_TYPE.number ? value : null,
      date_value: dataType === DATA_TYPE.date ? getUTCString(value) : null,
      created_at: getUTCString(createdAt),
    };
  });

  if (kafka.enabled) {
    await sendMessage('event_data', messages);
  } else {
    await insert('event_data', messages);
  }
}
