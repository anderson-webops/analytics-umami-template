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
