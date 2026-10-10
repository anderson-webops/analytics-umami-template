import { beforeEach, expect, test, vi } from 'vitest';
import { ReplayBudgetExceededError } from '@/lib/replay-budget';
import { parseRequest } from '@/lib/request';
import { getReplayChunks } from '@/queries/sql';
import { GET } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewAuthenticatedWebsite: vi.fn(async () => true) }));
vi.mock('@/queries/sql', () => ({ getReplayChunks: vi.fn() }));

const websiteId = '11111111-1111-4111-8111-111111111111';
const replayId = '22222222-2222-4222-8222-222222222222';
const request = new Request(`http://localhost/api/websites/${websiteId}/replays/${replayId}`);
const params = { params: Promise.resolve({ websiteId, replayId }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({ auth: { userId: 'actor' }, query: {} });
});

test('rejects a legacy replay that exceeds the guarded read budget', async () => {
  vi.mocked(getReplayChunks).mockRejectedValue(new ReplayBudgetExceededError());

  const response = await GET(request, params);

  expect(response.status).toBe(413);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ error: { code: 'payload-too-large' } });
});

test('rejects a legacy replay whose combined snapshots exceed the structure budget', async () => {
  const childNodes = Array.from({ length: 30_000 }, () => ({}));
  vi.mocked(getReplayChunks).mockResolvedValue([
    {
      sessionId: '33333333-3333-4333-8333-333333333333',
      visitId: replayId,
      events: [
        { type: 2, data: { node: { childNodes } } },
        { type: 2, data: { node: { childNodes } } },
      ],
      chunkIndex: 1,
      eventCount: 2,
      startedAt: new Date(),
      endedAt: new Date(),
    },
  ]);

  expect((await GET(request, params)).status).toBe(413);
});

test('rejects a dense snapshot hidden in legacy fragments before parsing it', async () => {
  const serialized = JSON.stringify({
    type: 2,
    data: { node: { childNodes: Array.from({ length: 90_000 }, () => ({})) } },
  });
  const midpoint = Math.floor(serialized.length / 2);
  vi.mocked(getReplayChunks).mockResolvedValue([
    {
      sessionId: '33333333-3333-4333-8333-333333333333',
      visitId: replayId,
      events: [serialized.slice(0, midpoint), serialized.slice(midpoint)].map((value, index) => ({
        type: 'umami:rrweb-event-fragment',
        data: { id: 'dense-legacy', index, total: 2, value },
      })),
      chunkIndex: 1,
      eventCount: 1,
      startedAt: new Date(),
      endedAt: new Date(),
    },
  ]);

  expect((await GET(request, params)).status).toBe(413);
});

test('preserves an ordinary authenticated replay response', async () => {
  vi.mocked(getReplayChunks).mockResolvedValue([
    {
      sessionId: '33333333-3333-4333-8333-333333333333',
      visitId: replayId,
      events: [{ type: 4, timestamp: 100 }],
      chunkIndex: 1,
      eventCount: 1,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:00:01Z'),
    },
  ]);

  const response = await GET(request, params);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ eventCount: 1, chunkCount: 1 });
});

test('redacts legacy stored navigation URLs before returning a replay', async () => {
  vi.mocked(getReplayChunks).mockResolvedValue([
    {
      sessionId: '33333333-3333-4333-8333-333333333333',
      visitId: replayId,
      events: [
        {
          type: 4,
          timestamp: 100,
          data: { href: 'https://example.com/private?token=secret#fragment', width: 800 },
        },
        {
          type: 5,
          timestamp: 101,
          data: {
            tag: 'url-change',
            payload: { url: 'https://example.com/next?code=secret' },
          },
        },
      ],
      chunkIndex: 1,
      eventCount: 2,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:00:01Z'),
    },
  ]);

  const response = await GET(request, params);
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.events[0].data).toEqual({ href: 'https://example.com/private', width: 800 });
  expect(payload.events[1].data.payload.url).toBe('https://example.com/next');
  expect(JSON.stringify(payload)).not.toContain('secret');
});

test('redacts a historical navigation event restored from fragments', async () => {
  const serialized = JSON.stringify({
    type: 4,
    timestamp: 100,
    data: { href: 'https://example.com/private?token=secret#fragment' },
  });
  const splitAt = Math.floor(serialized.length / 2);
  const fragments = [serialized.slice(0, splitAt), serialized.slice(splitAt)].map(
    (value, index) => ({
      type: 'umami:rrweb-event-fragment',
      timestamp: 100,
      data: { id: 'synthetic-fragment', index, total: 2, value },
    }),
  );
  vi.mocked(getReplayChunks).mockResolvedValue([
    {
      sessionId: '33333333-3333-4333-8333-333333333333',
      visitId: replayId,
      events: fragments,
      chunkIndex: 1,
      eventCount: 1,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:00:01Z'),
    },
  ]);

  const response = await GET(request, params);
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.events).toMatchObject([
    { type: 4, data: { href: 'https://example.com/private' } },
  ]);
  expect(JSON.stringify(payload)).not.toContain('secret');
});

test('removes resource URLs from a restored legacy snapshot before returning it', async () => {
  const event = {
    type: 2,
    timestamp: 100,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'img',
            attributes: { src: 'https://attacker.invalid/beacon', alt: 'Recorded image' },
            childNodes: [],
          },
        ],
      },
    },
  };
  const serialized = JSON.stringify(event);
  const midpoint = Math.floor(serialized.length / 2);
  const fragments = [serialized.slice(0, midpoint), serialized.slice(midpoint)].map(
    (value, index) => ({
      type: 'umami:rrweb-event-fragment',
      timestamp: 100,
      data: { id: 'legacy-snapshot', index, total: 2, value },
    }),
  );
  vi.mocked(getReplayChunks).mockResolvedValue([
    {
      sessionId: '33333333-3333-4333-8333-333333333333',
      visitId: replayId,
      events: fragments,
      chunkIndex: 1,
      eventCount: 1,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:00:01Z'),
    },
  ]);

  const response = await GET(request, params);
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.events).toHaveLength(1);
  expect(payload.events[0].data.node.childNodes[0].attributes).toEqual({ alt: 'Recorded image' });
});
