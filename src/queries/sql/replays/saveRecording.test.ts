import { gunzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { saveRecording } from './saveRecording';

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));

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

  expect(storedEvents[0].data.href).toBe('https://example.com/private');
  expect(storedEvents[1].data.payload.url).toBe('https://example.com/next');
  expect(JSON.stringify(storedEvents)).not.toContain('secret');
  expect(payload.eventCount).toBe(events.length);
  expect(events[0].data.href).toContain('token=secret');
});
