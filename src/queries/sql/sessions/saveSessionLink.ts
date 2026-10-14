import type { Prisma } from '@/generated/prisma/client';
import clickhouse from '@/lib/clickhouse';
import { FIELD_LENGTH } from '@/lib/constants';
import { truncateString } from '@/lib/format';
import kafka from '@/lib/kafka';
import prisma from '@/lib/prisma';
import {
  LINKED_QUERY_TIMEOUT_MS,
  MAX_AUTH_SESSION_ROWS,
  MAX_LINK_READ_ROWS,
} from '@/lib/share-query-budget';
import { getLegacyLinkedSessionIds } from './getLinkedSessionIds';

export interface SaveSessionLinkArgs {
  websiteId: string;
  sessionId: string;
  distinctId: string;
  createdAt?: Date;
}

export async function saveSessionLink(
  data: SaveSessionLinkArgs,
  transaction?: Prisma.TransactionClient,
): Promise<boolean> {
  const persist = async (admission: Prisma.TransactionClient) =>
    (await admitLink(data, admission)) !== 'at-cap';

  if (transaction) {
    return persist(transaction);
  }

  const admitted = await prisma.transaction(persist, { timeout: 30_000 });

  if (admitted && clickhouse.enabled) {
    await publishSessionLink(data);
  }

  return admitted;
}

export async function publishSessionLink({
  websiteId,
  sessionId,
  distinctId,
  createdAt,
}: SaveSessionLinkArgs): Promise<void> {
  if (!clickhouse.enabled) {
    return;
  }

  const normalizedDistinctId = truncateString(distinctId, FIELD_LENGTH.distinctId);
  const delivered = async () => {
    const rows = await clickhouse.rawQuery<{ sessionId: string }[]>(
      `select session_id as sessionId
       from session_link
       where website_id = {websiteId:UUID}
         and distinct_id = {distinctId:String}
         and session_id = {sessionId:UUID}
       limit 1`,
      { websiteId, distinctId: normalizedDistinctId, sessionId },
      'publishSessionLink',
      {
        maxExecutionTimeSeconds: LINKED_QUERY_TIMEOUT_MS / 1000,
        maxResultRows: 1,
        maxRowsToRead: MAX_LINK_READ_ROWS,
      },
    );

    return rows.length === 1;
  };

  if (await delivered()) {
    return;
  }

  const message = {
    website_id: websiteId,
    session_id: sessionId,
    distinct_id: normalizedDistinctId,
    created_at: clickhouse.getUTCString(createdAt),
  };

  if (kafka.enabled) {
    const acknowledgements = await kafka.sendMessage('session_link', [message]);

    if (acknowledgements.length === 0) {
      throw new Error('SESSION_LINK_DELIVERY_UNAVAILABLE');
    }
  } else {
    await clickhouse.insert('session_link', [message]);
  }

  for (const delay of [0, 100, 250, 500]) {
    if (delay) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    if (await delivered()) {
      return;
    }
  }

  throw new Error('SESSION_LINK_DELIVERY_UNCONFIRMED');
}

async function admitLink(
  { websiteId, sessionId, distinctId, createdAt }: SaveSessionLinkArgs,
  transaction: Prisma.TransactionClient,
): Promise<'new' | 'existing' | 'at-cap'> {
  const normalizedDistinctId = truncateString(distinctId, FIELD_LENGTH.distinctId);
  const where = { websiteId, distinctId: normalizedDistinctId };

  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${websiteId}), hashtext(${`session-link:${normalizedDistinctId}`}))::text`;

  const existing = await transaction.sessionLink.findUnique({
    where: { websiteId_distinctId_sessionId: { ...where, sessionId } },
    select: { sessionId: true },
  });

  if (existing) {
    return 'existing';
  }

  if (clickhouse.enabled) {
    const [persisted, legacy] = await Promise.all([
      transaction.sessionLink.findMany({
        where,
        select: { sessionId: true },
        take: MAX_AUTH_SESSION_ROWS + 1,
      }),
      getLegacyLinkedSessionIds(websiteId, normalizedDistinctId, MAX_AUTH_SESSION_ROWS + 1),
    ]);

    if (legacy.some(link => link.sessionId === sessionId)) {
      return 'existing';
    }

    const linkedSessionIds = new Set(persisted.map(({ sessionId }) => sessionId));

    if (linkedSessionIds.size >= MAX_AUTH_SESSION_ROWS) {
      return 'at-cap';
    }

    for (const { sessionId } of legacy) {
      linkedSessionIds.add(sessionId);
      if (linkedSessionIds.size >= MAX_AUTH_SESSION_ROWS) {
        return 'at-cap';
      }
    }
  } else if ((await transaction.sessionLink.count({ where })) >= MAX_AUTH_SESSION_ROWS) {
    return 'at-cap';
  }

  await transaction.sessionLink.create({
    data: {
      websiteId,
      sessionId,
      distinctId: normalizedDistinctId,
      createdAt,
    },
  });

  return 'new';
}
