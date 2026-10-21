export const PRISMA = 'prisma';
export const POSTGRESQL = 'postgresql';
export const CLICKHOUSE = 'clickhouse';
export const KAFKA = 'kafka';
export const KAFKA_PRODUCER = 'kafka-producer';

// Fixes issue with converting bigint values
(BigInt.prototype as unknown as { toJSON(): number }).toJSON = function () {
  return Number(this);
};

export function getDatabaseType(url = process.env.DATABASE_URL) {
  const type = url?.split(':')[0];

  if (type === 'postgres') {
    return POSTGRESQL;
  }

  return type;
}

export function isRelationalOnly() {
  return !process.env.CLICKHOUSE_URL && getDatabaseType() === POSTGRESQL;
}

export function isSessionDeletionAvailable() {
  return (
    isRelationalOnly() &&
    process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN === 'true' &&
    isKafkaHistorySafeForDeletion()
  );
}

export function isKafkaHistorySafeForDeletion() {
  return (
    !process.env.KAFKA_URL &&
    !process.env.KAFKA_BROKER &&
    process.env.KAFKA_HISTORY_ATTESTED_CLEAN === 'true'
  );
}

export function assertKafkaHistorySafeForDeletion() {
  if (!isKafkaHistorySafeForDeletion()) {
    throw new Error('KAFKA_HISTORY_REVIEW_REQUIRED');
  }
}

export async function runQuery(queries: any) {
  if (process.env.CLICKHOUSE_URL) {
    if (queries[KAFKA]) {
      return queries[KAFKA]();
    }

    return queries[CLICKHOUSE]();
  }

  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return queries[PRISMA]();
  }
}

export function notImplemented() {
  throw new Error('Not implemented.');
}
