import { gunzipSync } from 'node:zlib';
import { afterEach, expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import clickhouse from '@/lib/clickhouse';
import kafka, { getMaxMessageBytes } from '@/lib/kafka';
import { restoreReplayEventFragments } from '@/lib/replay';
import { saveReassembledRecordingFragments, saveRecording } from './saveRecording';

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/lib/clickhouse', () => ({
  default: {
    enabled: true,
    getUTCString: vi.fn((date: Date) => date.toISOString()),
    insert: vi.fn(async () => ({})),
  },
}));
vi.mock('@/lib/kafka', () => ({
  default: { enabled: true, sendMessage: vi.fn(async () => []) },
  getMaxMessageBytes: vi.fn(() => 900_000),
}));

afterEach(() => {
  kafka.enabled = true;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

test('stores redacted navigation URLs without changing replay event counts', async () => {
  const create = vi.fn(async (_input: { data: { events: Buffer; eventCount: number } }) => ({}));
  const events = [
    { type: 4, timestamp: 1, data: { href: 'https://example.com/private?token=secret#part' } },
    {
      type: 5,
      timestamp: 2,
      data: { tag: 'url-change', payload: { url: 'https://example.com/next?code=secret' } },
    },
  ];

  await saveRecording(
    {
      websiteId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      visitId: '33333333-3333-4333-8333-333333333333',
      chunkIndex: 1,
      events,
      eventCount: events.length,
      startedAt: new Date(1),
      endedAt: new Date(2),
    },
    { sessionReplay: { create } } as unknown as Prisma.TransactionClient,
  );

  const payload = create.mock.lastCall?.[0]?.data;

  if (!payload) {
    throw new Error('Replay insert was not called.');
  }

  const storedEvents = JSON.parse(gunzipSync(payload.events).toString('utf8'));

  expect(storedEvents[0].data.href).toBe('');
  expect(storedEvents[1].data.payload).toEqual({});
  expect(JSON.stringify(storedEvents)).not.toContain('secret');
  expect(payload.eventCount).toBe(events.length);
  expect(events[0].data.href).toContain('token=secret');
});

test('does not persist unrecognized custom replay URLs', async () => {
  const create = vi.fn(async (_input: { data: { events: Buffer; eventCount: number } }) => ({}));
  const events = [
    { type: 5, timestamp: 1, data: { tag: 'custom', payload: { url: '/reset?token=secret' } } },
    {
      type: 5,
      timestamp: 2,
      data: { tag: 'url-change', payload: { url: '/next?token=secret', extra: 'secret' } },
    },
  ];

  await saveRecording(
    {
      websiteId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      visitId: '33333333-3333-4333-8333-333333333333',
      chunkIndex: 1,
      events,
      eventCount: events.length,
      startedAt: new Date(1),
      endedAt: new Date(2),
    },
    { sessionReplay: { create } } as unknown as Prisma.TransactionClient,
  );

  const stored = create.mock.lastCall?.[0]?.data;
  expect(stored?.eventCount).toBe(1);
  expect(JSON.parse(gunzipSync(stored.events).toString('utf8'))).toEqual([
    { type: 5, timestamp: 2, data: { payload: {} } },
  ]);
});

test('does not persist resource URLs from snapshots or attribute mutations', async () => {
  const create = vi.fn(async (_input: { data: { events: Buffer } }) => ({}));
  const events = [
    {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'img',
              attributes: {
                alt: 'Recorded image? #1',
                src: 'https://assets.example/photo?signature=snapshot-secret#part',
                'data-resource-url': 'https://assets.example/private?key=data-secret',
                style: 'background:url(https://assets.example/bg?key=style-secret)',
              },
              childNodes: [{ type: 3, id: 3, textContent: 'private-snapshot-text' }],
            },
          ],
        },
      },
    },
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        adds: [],
        attributes: [
          {
            id: 2,
            attributes: {
              poster: 'https://assets.example/poster?token=mutation-secret',
            },
          },
        ],
        texts: [],
        removes: [],
      },
    },
    { type: 3, timestamp: 3, data: { source: 5, id: 2, text: 'private-input-text' } },
  ];

  await saveRecording(
    {
      websiteId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      visitId: '33333333-3333-4333-8333-333333333333',
      chunkIndex: 2,
      events,
      eventCount: events.length,
      startedAt: new Date(1),
      endedAt: new Date(2),
    },
    { sessionReplay: { create } } as unknown as Prisma.TransactionClient,
  );

  const payload = create.mock.lastCall?.[0]?.data;

  if (!payload) {
    throw new Error('Replay insert was not called.');
  }

  const storedEvents = JSON.parse(gunzipSync(payload.events).toString('utf8'));
  const serialized = JSON.stringify(storedEvents);

  expect(serialized).not.toMatch(
    /snapshot-secret|data-secret|style-secret|mutation-secret|private-snapshot-text|private-input-text/,
  );
  expect(storedEvents[0].data.node.childNodes[0].attributes).toEqual({});
  expect(storedEvents[1].data.attributes).toEqual({});
  expect(JSON.stringify(events)).toContain('snapshot-secret');
});

test('does not persist resource CSS when a style-text mutation arrives in a later chunk', async () => {
  const create = vi.fn(async (_input: { data: { events: Buffer } }) => ({}));
  const transaction = { sessionReplay: { create } } as unknown as Prisma.TransactionClient;
  const base = {
    websiteId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    visitId: '33333333-3333-4333-8333-333333333333',
    eventCount: 1,
    startedAt: new Date(1),
    endedAt: new Date(1),
  };
  const style = {
    type: 2,
    timestamp: 1,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'style',
            attributes: {},
            childNodes: [{ type: 3, id: 3, textContent: 'body{color:red}' }],
          },
        ],
      },
    },
  };
  const mutation = {
    type: 3,
    timestamp: 2,
    data: {
      source: 0,
      adds: [
        {
          parentId: 2,
          nextId: null,
          node: { type: 3, id: 4, textContent: 'body{background:u\\72l(/photo?token=add-secret)}' },
        },
      ],
      attributes: [],
      texts: [
        { id: 3, value: 'body{background:url(/photo?token=text-secret)}' },
        { id: 5, value: 'Visible ordinary text' },
        { id: 6, value: 'body{background:u\\72l(/photo?token=escaped-secret)}' },
      ],
      removes: [],
    },
  };

  await saveRecording({ ...base, chunkIndex: 10, events: [style] }, transaction);
  await saveRecording({ ...base, chunkIndex: 11, events: [mutation] }, transaction);

  const stored = create.mock.calls.map(([input]) =>
    JSON.parse(gunzipSync(input.data.events).toString('utf8')),
  );
  expect(JSON.stringify(stored)).not.toMatch(/add-secret|text-secret|escaped-secret/);
  expect(stored[1][0].data.texts[1].value).toBe('');
});

test.each([true, false])('rejects raw replay fragments (valid=%s)', async valid => {
  const create = vi.fn(async () => ({}));
  const fragment = {
    type: 'umami:rrweb-event-fragment',
    timestamp: 1,
    data: {
      id: 'snapshot-1',
      index: 0,
      total: 2,
      value: '{"type":2,"data":{"node":{"attributes":{"src":"https://assets.example/?',
    },
  };

  if (!valid) {
    fragment.data.total = 0;
  }

  await expect(
    saveRecording(
      {
        websiteId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        visitId: '33333333-3333-4333-8333-333333333333',
        chunkIndex: 3,
        events: [fragment],
        eventCount: 1,
        startedAt: new Date(1),
        endedAt: new Date(1),
      },
      { sessionReplay: { create } } as unknown as Prisma.TransactionClient,
    ),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

test('persists only sanitized fragment values and reconstructs the same safe snapshot', async () => {
  const create = vi.fn(async (_input: { data: { events: Buffer; chunkIndex: number } }) => ({}));
  const event = {
    type: 2,
    timestamp: 1,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'img',
            attributes: { alt: 'Photo', src: 'https://assets.example/?token=fragment-secret' },
            childNodes: [],
          },
        ],
      },
    },
  };

  await saveReassembledRecordingFragments(
    {
      websiteId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      visitId: '33333333-3333-4333-8333-333333333333',
      event,
      parts: [
        { id: 'safe-snapshot', index: 0, total: 2, chunkIndex: 10, timestamp: 1 },
        { id: 'safe-snapshot', index: 1, total: 2, chunkIndex: 11, timestamp: 1 },
      ],
      startedAt: new Date(1),
      endedAt: new Date(1),
    },
    { sessionReplay: { create } } as unknown as Prisma.TransactionClient,
  );

  expect(create).toHaveBeenCalledTimes(2);
  const stored = create.mock.calls.map(([input]) => ({
    chunkIndex: input.data.chunkIndex,
    events: JSON.parse(gunzipSync(input.data.events).toString('utf8')),
  }));

  expect(stored.map(chunk => chunk.chunkIndex)).toEqual([10, 11]);
  expect(JSON.stringify(stored)).not.toContain('fragment-secret');
  const [restored] = restoreReplayEventFragments(stored.flatMap(chunk => chunk.events));
  expect(restored.data.node.childNodes[0].attributes).toEqual({});
});

test('sends only sanitized fragment values to the external Kafka sink', async () => {
  vi.stubEnv('CLICKHOUSE_URL', 'http://synthetic.invalid:8123/analytics');
  const event = {
    type: 2,
    timestamp: 1,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'img',
            attributes: { alt: 'Photo', src: 'https://assets.example/?token=kafka-secret' },
            childNodes: [],
          },
        ],
      },
    },
  };
  const args = {
    websiteId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    visitId: '33333333-3333-4333-8333-333333333333',
    event,
    parts: [
      { id: 'kafka-snapshot', index: 0, total: 2, chunkIndex: 10, timestamp: 1 },
      { id: 'kafka-snapshot', index: 1, total: 2, chunkIndex: 11, timestamp: 1 },
    ],
    startedAt: new Date(1),
    endedAt: new Date(1),
  };

  await saveReassembledRecordingFragments(args);

  const messages = vi
    .mocked(kafka.sendMessage)
    .mock.calls.flatMap(([, message]) => (Array.isArray(message) ? message : [message]));
  expect(messages).toHaveLength(2);
  expect(JSON.stringify(messages)).not.toContain('kafka-secret');
  expect(messages.map(message => message.chunk_index)).toEqual([10, 11]);
  expect(messages.map(message => message.event_count)).toEqual([1, 0]);
  expect(messages.every(message => message.retention_policy === 1)).toBe(true);
  expect(
    messages.every(
      message => new Date(String(message.ingested_at)).getTime() > Date.now() - 60_000,
    ),
  ).toBe(true);
  expect(messages.every(message => message.ingested_at !== message.started_at)).toBe(true);
  expect(
    restoreReplayEventFragments(messages.flatMap(message => JSON.parse(String(message.events)))),
  ).toHaveLength(1);

  vi.mocked(getMaxMessageBytes).mockReturnValueOnce(1000);
  vi.mocked(kafka.sendMessage).mockClear();
  await expect(
    saveReassembledRecordingFragments({
      ...args,
      event: {
        ...event,
        data: {
          node: {
            ...event.data.node,
            childNodes: [
              {
                ...event.data.node.childNodes[0],
                attributes: { alt: 'a'.repeat(3000) },
              },
            ],
          },
        },
      },
    }),
  ).rejects.toThrow();
  expect(kafka.sendMessage).not.toHaveBeenCalled();
});

test('surfaces a partial external fragment write instead of reporting success', async () => {
  vi.stubEnv('CLICKHOUSE_URL', 'http://synthetic.invalid:8123/analytics');
  const event = {
    type: 2,
    timestamp: 1,
    data: { node: { type: 0, id: 1, childNodes: [] } },
  };
  vi.mocked(kafka.sendMessage)
    .mockResolvedValueOnce([{} as Awaited<ReturnType<typeof kafka.sendMessage>>[number]])
    .mockRejectedValueOnce(new Error('Synthetic second-fragment failure'));

  await expect(
    saveReassembledRecordingFragments({
      websiteId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      visitId: '33333333-3333-4333-8333-333333333333',
      event,
      parts: [
        { id: 'partial-snapshot', index: 0, total: 2, chunkIndex: 10, timestamp: 1 },
        { id: 'partial-snapshot', index: 1, total: 2, chunkIndex: 11, timestamp: 1 },
      ],
      startedAt: new Date(1),
      endedAt: new Date(1),
    }),
  ).rejects.toThrow('Synthetic second-fragment failure');

  expect(kafka.sendMessage).toHaveBeenCalledTimes(2);
  const messages = vi
    .mocked(kafka.sendMessage)
    .mock.calls.flatMap(([, message]) => (Array.isArray(message) ? message : [message]));
  expect(messages.map(message => message.chunk_index)).toEqual([10, 11]);
});

test('sends only sanitized ordinary and reassembled events to direct ClickHouse', async () => {
  vi.stubEnv('CLICKHOUSE_URL', 'http://synthetic.invalid:8123/analytics');
  kafka.enabled = false;
  const event = {
    type: 2,
    timestamp: 1,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'img',
            attributes: { alt: 'Photo', src: 'https://assets.example/?token=clickhouse-secret' },
            childNodes: [],
          },
        ],
      },
    },
  };
  const base = {
    websiteId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    visitId: '33333333-3333-4333-8333-333333333333',
    startedAt: new Date(1),
    endedAt: new Date(1),
  };

  await saveReassembledRecordingFragments({
    ...base,
    event,
    parts: [
      { id: 'clickhouse-snapshot', index: 0, total: 2, chunkIndex: 10, timestamp: 1 },
      { id: 'clickhouse-snapshot', index: 1, total: 2, chunkIndex: 11, timestamp: 1 },
    ],
  });
  await saveRecording({ ...base, chunkIndex: 12, events: [event], eventCount: 1 });

  const rows = vi.mocked(clickhouse.insert).mock.calls.flatMap(([, values]) => values);
  expect(rows).toHaveLength(3);
  expect(rows.every(row => row.retention_policy === 1)).toBe(true);
  expect(rows.every(row => new Date(row.ingested_at).getTime() > Date.now() - 60_000)).toBe(true);
  expect(rows.every(row => row.ingested_at !== row.started_at)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('clickhouse-secret');
  expect(
    restoreReplayEventFragments(rows.slice(0, 2).flatMap(row => JSON.parse(row.events))),
  ).toHaveLength(1);
  expect(JSON.parse(rows[2].events)[0].data.node.childNodes[0].attributes).toEqual({});
  expect(kafka.sendMessage).not.toHaveBeenCalled();
});
