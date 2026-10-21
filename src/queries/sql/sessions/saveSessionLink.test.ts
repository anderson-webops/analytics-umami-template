import { afterEach, expect, test, vi } from 'vitest';
import { MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';

const data = {
  websiteId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  distinctId: 'visitor-1',
};

function makeSessionId(index: number) {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

async function loadSaveSessionLink(clickhouseEnabled: boolean, kafkaEnabled = false) {
  vi.resetModules();

  const admission = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    sessionLink: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(data),
      update: vi.fn().mockResolvedValue(data),
    },
  };
  const transaction = vi.fn(async operation => operation(admission));
  const getLegacyLinkedSessionIds = vi.fn().mockResolvedValue([]);
  const rawQuery = vi.fn().mockResolvedValue([{ sessionId: data.sessionId }]);
  const insert = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue([{ topicName: 'session_link' }]);

  vi.doMock('@/lib/prisma', () => ({ default: { transaction } }));
  vi.doMock('@/lib/clickhouse', () => ({
    default: {
      enabled: clickhouseEnabled,
      rawQuery,
      insert,
      getUTCString: () => '2026-01-01 00:00:00',
    },
  }));
  vi.doMock('@/lib/kafka', () => ({ default: { enabled: kafkaEnabled, sendMessage } }));
  vi.doMock('./getLinkedSessionIds', () => ({ getLegacyLinkedSessionIds }));

  const { saveSessionLink, publishSessionLink } = await import('./saveSessionLink');

  return {
    saveSessionLink,
    publishSessionLink,
    admission,
    transaction,
    getLegacyLinkedSessionIds,
    rawQuery,
    insert,
    sendMessage,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

test.each([false, true])(
  'the %s storage mode admits only new links below the shared identity cap',
  async clickhouseEnabled => {
    const { saveSessionLink, admission, transaction, getLegacyLinkedSessionIds } =
      await loadSaveSessionLink(clickhouseEnabled);

    expect(await saveSessionLink(data)).toBe(true);
    expect(admission.$queryRaw).toHaveBeenCalledTimes(1);
    expect(admission.sessionLink.create).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);

    if (clickhouseEnabled) {
      expect(admission.sessionLink.findMany).toHaveBeenCalledWith({
        where: { websiteId: data.websiteId, distinctId: data.distinctId },
        select: { sessionId: true },
        take: MAX_AUTH_SESSION_ROWS + 1,
      });
      expect(getLegacyLinkedSessionIds).toHaveBeenCalledWith(
        data.websiteId,
        data.distinctId,
        MAX_AUTH_SESSION_ROWS + 1,
      );
      expect(admission.sessionLink.count).not.toHaveBeenCalled();
    } else {
      expect(admission.sessionLink.count).toHaveBeenCalledWith({
        where: { websiteId: data.websiteId, distinctId: data.distinctId },
      });
      expect(getLegacyLinkedSessionIds).not.toHaveBeenCalled();
    }

    admission.sessionLink.findUnique.mockResolvedValue({ sessionId: data.sessionId, trustTier: 1 });
    expect(await saveSessionLink(data)).toBe(true);
    expect(admission.sessionLink.create).toHaveBeenCalledTimes(1);
    expect(admission.sessionLink.update).not.toHaveBeenCalled();

    admission.sessionLink.findUnique.mockResolvedValue(null);
    if (clickhouseEnabled) {
      admission.sessionLink.findMany.mockResolvedValue(
        Array.from({ length: MAX_AUTH_SESSION_ROWS }, (_, index) => ({
          sessionId: makeSessionId(index),
        })),
      );
    } else {
      admission.sessionLink.count.mockResolvedValue(MAX_AUTH_SESSION_ROWS);
    }
    expect(
      await saveSessionLink({ ...data, sessionId: '33333333-3333-4333-8333-333333333333' }),
    ).toBe(false);
    expect(admission.sessionLink.create).toHaveBeenCalledTimes(1);
  },
);

test('ClickHouse legacy links and newly admitted PostgreSQL links share one cap', async () => {
  const { saveSessionLink, admission, getLegacyLinkedSessionIds } = await loadSaveSessionLink(true);
  const legacy = Array.from({ length: MAX_AUTH_SESSION_ROWS - 1 }, (_, index) => ({
    sessionId: makeSessionId(index),
  }));
  getLegacyLinkedSessionIds.mockResolvedValue(legacy);
  admission.sessionLink.findMany.mockResolvedValue([{ sessionId: makeSessionId(0) }]);

  expect(await saveSessionLink(data)).toBe(true);
  expect(admission.sessionLink.create).toHaveBeenCalledTimes(1);

  admission.sessionLink.findMany.mockResolvedValue([{ sessionId: makeSessionId(1999) }]);
  expect(await saveSessionLink({ ...data, sessionId: makeSessionId(2001) })).toBe(false);
  expect(admission.sessionLink.create).toHaveBeenCalledTimes(1);
});

test('ClickHouse admission rejects a PostgreSQL history beyond the bounded fetch', async () => {
  const { saveSessionLink, admission, getLegacyLinkedSessionIds } = await loadSaveSessionLink(true);
  admission.sessionLink.findMany.mockResolvedValue(
    Array.from({ length: MAX_AUTH_SESSION_ROWS + 1 }, (_, index) => ({
      sessionId: makeSessionId(index),
    })),
  );
  getLegacyLinkedSessionIds.mockResolvedValue([{ sessionId: makeSessionId(0) }]);

  expect(await saveSessionLink(data)).toBe(false);
  expect(admission.sessionLink.create).not.toHaveBeenCalled();
});

test('ClickHouse history-read failure never admits another link', async () => {
  const { saveSessionLink, admission, getLegacyLinkedSessionIds } = await loadSaveSessionLink(true);
  getLegacyLinkedSessionIds.mockRejectedValue(new Error('read limit exceeded'));

  await expect(saveSessionLink(data)).rejects.toThrow('read limit exceeded');
  expect(admission.sessionLink.create).not.toHaveBeenCalled();
});

test('ClickHouse admission reuses the caller transaction without acquiring a second connection', async () => {
  const { saveSessionLink, admission, transaction, rawQuery, insert } =
    await loadSaveSessionLink(true);

  expect(await saveSessionLink(data, admission as any)).toBe(true);
  expect(transaction).not.toHaveBeenCalled();
  expect(admission.sessionLink.create).toHaveBeenCalledTimes(1);
  expect(rawQuery).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
});

test('ClickHouse admission promotes an existing unverified link without increasing identity cardinality', async () => {
  const { saveSessionLink, admission, getLegacyLinkedSessionIds, insert } =
    await loadSaveSessionLink(true);
  getLegacyLinkedSessionIds.mockResolvedValue(
    Array.from({ length: MAX_AUTH_SESSION_ROWS }, (_, index) => ({
      sessionId: index === 0 ? data.sessionId : makeSessionId(index),
    })),
  );

  expect(await saveSessionLink(data)).toBe(true);
  expect(admission.sessionLink.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ trustTier: 1 }),
  });
  expect(insert).not.toHaveBeenCalled();
});

test('backend-authorized identify upgrades a historical PostgreSQL link', async () => {
  const { saveSessionLink, admission } = await loadSaveSessionLink(false);
  admission.sessionLink.findUnique.mockResolvedValue({ sessionId: data.sessionId, trustTier: 0 });

  expect(await saveSessionLink(data)).toBe(true);
  expect(admission.sessionLink.update).toHaveBeenCalledWith({
    where: {
      websiteId_distinctId_sessionId: {
        websiteId: data.websiteId,
        distinctId: data.distinctId,
        sessionId: data.sessionId,
      },
    },
    data: { trustTier: 1 },
  });
  expect(admission.sessionLink.create).not.toHaveBeenCalled();
});

test('ClickHouse delivery follows committed admission and is idempotent', async () => {
  const { saveSessionLink, rawQuery, insert, transaction } = await loadSaveSessionLink(true);
  rawQuery.mockResolvedValueOnce([]).mockResolvedValue([{ sessionId: data.sessionId }]);
  insert.mockImplementation(async () => {
    expect(transaction.mock.results[0].type).toBe('return');
    await transaction.mock.results[0].value;
  });

  expect(await saveSessionLink(data)).toBe(true);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(await saveSessionLink(data)).toBe(true);
  expect(insert).toHaveBeenCalledTimes(1);
});

test('an unacknowledged Kafka delivery cannot claim a saved ClickHouse link', async () => {
  const { publishSessionLink, rawQuery, insert, sendMessage } = await loadSaveSessionLink(
    true,
    true,
  );
  rawQuery.mockResolvedValue([]);
  sendMessage.mockResolvedValue([]);

  await expect(publishSessionLink(data)).rejects.toThrow('SESSION_LINK_DELIVERY_UNAVAILABLE');
  expect(insert).not.toHaveBeenCalled();
  expect(rawQuery).toHaveBeenCalledTimes(1);
});

test('a Kafka acknowledgement without a readable ClickHouse row cannot claim the link', async () => {
  const { publishSessionLink, rawQuery, insert, sendMessage } = await loadSaveSessionLink(
    true,
    true,
  );
  rawQuery.mockResolvedValue([]);

  await expect(publishSessionLink(data)).rejects.toThrow('SESSION_LINK_DELIVERY_UNCONFIRMED');
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(insert).not.toHaveBeenCalled();
  expect(rawQuery).toHaveBeenCalledTimes(5);
});
