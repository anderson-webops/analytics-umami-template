import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import {
  getCollectionIpLimit,
  getCollectionSourceLimit,
  getCollectionSourceStatus,
} from '@/lib/collection-rate-limit';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { HeatmapBudgetExceededError, reserveHeatmapBudget } from '@/lib/heatmap-budget';
import { parseToken } from '@/lib/jwt';
import { reserveReplayBudget } from '@/lib/replay-budget';
import { parseRequest } from '@/lib/request';
import { getWebsite, withActiveCollectionSource } from '@/queries/prisma';
import { saveRecording } from '@/queries/sql';
import { saveHeatmapEvents } from '@/queries/sql/heatmap/saveHeatmapEvents';
import { OPTIONS, POST } from './route';

const clickhouseState = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    get enabled() {
      return clickhouseState.enabled;
    },
  },
}));

vi.mock('@/lib/collection-rate-limit', () => ({
  getCollectionIpLimit: vi.fn(),
  getCollectionSourceLimit: vi.fn(),
  getCollectionSourceStatus: vi.fn(),
}));

vi.mock('@/lib/detect', () => ({
  getClientInfo: vi.fn(),
  hasBlockedIp: vi.fn(),
}));

vi.mock('@/lib/jwt', () => ({
  parseToken: vi.fn(),
}));

vi.mock('@/lib/heatmap-budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/heatmap-budget')>()),
  reserveHeatmapBudget: vi.fn(),
}));

vi.mock('@/lib/replay-budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/replay-budget')>()),
  reserveReplayBudget: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  getWebsite: vi.fn(),
  withActiveCollectionSource: vi.fn(),
}));

vi.mock('@/queries/sql', () => ({
  saveRecording: vi.fn(),
}));

vi.mock('@/queries/sql/heatmap/saveHeatmapEvents', () => ({
  saveHeatmapEvents: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  clickhouseState.enabled = false;
  vi.mocked(getCollectionIpLimit).mockResolvedValue({ blocked: false, retryAfter: 60 });
  vi.mocked(getCollectionSourceLimit).mockResolvedValue({ blocked: false, retryAfter: 60 });
  vi.mocked(getCollectionSourceStatus).mockResolvedValue({ blocked: false, retryAfter: 60 });
});

test('recording blocks a saturated IP before parsing and preserves CORS headers', async () => {
  vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

  const response = await POST(new Request('http://localhost/api/record', { method: 'POST' }));

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(parseRequestMock).not.toHaveBeenCalled();
  expect(getCollectionSourceStatus).not.toHaveBeenCalled();
});

test('recording charges malformed bodies before parsing', async () => {
  parseRequestMock.mockResolvedValue({
    body: undefined,
    error: () => Response.json({ error: 'bad request' }, { status: 400 }),
  });

  const response = await POST(new Request('http://localhost/api/record', { method: 'POST' }));

  expect(response.status).toBe(400);
  expect(getCollectionIpLimit).toHaveBeenCalledOnce();
  expect(vi.mocked(getCollectionIpLimit).mock.invocationCallOrder[0]).toBeLessThan(
    parseRequestMock.mock.invocationCallOrder[0],
  );
  expect(getCollectionSourceStatus).not.toHaveBeenCalled();
});

test.each(['record', 'heatmap'])('%s preflight rejects oversized event arrays', async type => {
  parseRequestMock.mockResolvedValue({
    error: () => Response.json({ error: 'bad request' }, { status: 400 }),
  });

  expect((await POST(new Request('http://localhost/api/record', { method: 'POST' }))).status).toBe(
    400,
  );

  const preflight = parseRequestMock.mock.calls[0][2]?.bodyPreflight;
  const body = (events: unknown[]) => ({ type, payload: { website: 'website-1', events } });

  expect(preflight?.(body(Array(200).fill({ type: 'click', url: '/' })))).toBe(true);
  expect(preflight?.(body(Array(201).fill(null)))).toBe(false);
  expect(preflight?.(body(Array(10_000).fill(null)))).toBe(false);
  expect(preflight?.(Array(10_000).fill(null))).toBe(false);
  if (type === 'heatmap') {
    expect(preflight?.(body([{ type: 'click', url: '/' }]))).toBe(true);
    expect(
      preflight?.(
        body([
          Object.fromEntries(
            Array.from({ length: 1000 }, (_, index) => [`unexpected_${index}`, true]),
          ),
        ]),
      ),
    ).toBe(false);
    expect(preflight?.(body([{ type: 'click', url: '/', ['x'.repeat(1000)]: 1 }]))).toBe(false);
  }
  expect(getCollectionSourceStatus).not.toHaveBeenCalled();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function prepareHeatmapRequest() {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const visitId = '33333333-3333-4333-8333-333333333333';
  const transaction = {
    website: {
      findFirst: vi.fn().mockResolvedValue({
        recorderEnabled: true,
        replayConfig: { heatmapEnabled: true, replayEnabled: true },
        userId: ACCOUNT_ID,
        teamId: null,
      }),
    },
  };

  vi.stubEnv('APP_SECRET', 'synthetic-test-secret-00000000000000000');
  vi.mocked(getClientInfo).mockResolvedValue({ ip: '127.0.0.1' } as any);
  vi.mocked(hasBlockedIp).mockReturnValue(false);
  vi.mocked(parseToken).mockReturnValue({
    type: 'cache',
    websiteId,
    sessionId,
    visitId,
    iat: Math.floor(Date.now() / 1000),
  } as any);
  vi.mocked(getWebsite).mockResolvedValue({ recorderEnabled: true } as any);
  vi.mocked(withActiveCollectionSource).mockImplementation((_, __, operation) =>
    operation(transaction as any),
  );
  parseRequestMock.mockResolvedValue({
    body: {
      type: 'heatmap',
      payload: {
        website: websiteId,
        events: [{ type: 'click', url: '/', x: 1, y: 2 }],
      },
    },
    error: undefined,
  });

  return { websiteId, visitId, transaction };
}

function prepareReplayRequest() {
  const { websiteId, visitId } = prepareHeatmapRequest();
  vi.mocked(reserveReplayBudget).mockResolvedValue(true);
  parseRequestMock.mockResolvedValue({
    body: {
      type: 'record',
      payload: {
        website: websiteId,
        timestamp: Math.floor(Date.now() / 1000),
        events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      },
    },
    error: undefined,
  });

  return { websiteId, visitId };
}

describe('heatmap intake budget', () => {
  test('does not count an unverified source when the IP limit is reached', async () => {
    prepareHeatmapRequest();
    vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(429);
    expect(parseToken).not.toHaveBeenCalled();
    expect(getCollectionSourceStatus).not.toHaveBeenCalled();
    expect(getCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('does not repeat a website lookup for an already throttled source', async () => {
    prepareHeatmapRequest();
    vi.mocked(getCollectionSourceStatus).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(429);
    expect(getWebsite).not.toHaveBeenCalled();
    expect(getCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('does not count a source without a matching session token', async () => {
    prepareHeatmapRequest();
    vi.mocked(parseToken).mockReturnValueOnce(null);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(400);
    expect(getCollectionSourceStatus).not.toHaveBeenCalled();
    expect(getCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('does not count a source after its website is deleted', async () => {
    prepareHeatmapRequest();
    vi.mocked(getWebsite).mockResolvedValueOnce(null);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(400);
    expect(getCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('does not count a source when the client IP is blocked', async () => {
    prepareHeatmapRequest();
    vi.mocked(hasBlockedIp).mockReturnValueOnce(true);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(204);
    expect(getCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('reserves capacity before a relational write', async () => {
    const { websiteId, visitId } = prepareHeatmapRequest();
    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(reserveHeatmapBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        websiteId,
        visitId,
        events: 1,
        accountType: 'user',
        accountId: ACCOUNT_ID,
      }),
    );
    expect(saveHeatmapEvents).toHaveBeenCalledOnce();
    expect(getCollectionSourceLimit).toHaveBeenCalledWith(websiteId);
    expect(getCollectionSourceStatus).toHaveBeenCalledWith(websiteId);
    expect(vi.mocked(getCollectionIpLimit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(getCollectionSourceLimit).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(reserveHeatmapBudget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(saveHeatmapEvents).mock.invocationCallOrder[0],
    );
  });

  test('charges the team owner of a team-owned website', async () => {
    const { transaction } = prepareHeatmapRequest();
    const teamId = '55555555-5555-4555-8555-555555555555';
    transaction.website.findFirst.mockResolvedValue({
      recorderEnabled: true,
      replayConfig: { heatmapEnabled: true },
      userId: null,
      teamId,
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(reserveHeatmapBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountType: 'team', accountId: teamId }),
    );
  });

  test('does not write when a website has no owner', async () => {
    const { transaction } = prepareHeatmapRequest();
    transaction.website.findFirst.mockResolvedValue({
      recorderEnabled: true,
      replayConfig: { heatmapEnabled: true },
      userId: null,
      teamId: null,
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(500);
    expect(reserveHeatmapBudget).not.toHaveBeenCalled();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('normalizes recorder website UUIDs before token and source checks', async () => {
    prepareHeatmapRequest();
    await POST(new Request('http://localhost/api/record', { method: 'POST' }));
    const schema = parseRequestMock.mock.calls[0][1];
    const mixedCaseId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const parsed = schema.parse({
      type: 'record',
      payload: { website: mixedCaseId, events: [] },
    });

    expect(parsed.payload.website).toBe(mixedCaseId.toLowerCase());
  });

  test('accepts an existing cache token with an alternate UUID spelling', async () => {
    const { websiteId } = prepareHeatmapRequest();
    vi.mocked(parseToken).mockReturnValueOnce({
      type: 'cache',
      websiteId: websiteId.toUpperCase(),
      sessionId: '22222222-2222-4222-8222-222222222222',
      visitId: '33333333-3333-4333-8333-333333333333',
      iat: Math.floor(Date.now() / 1000),
    } as any);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(getCollectionSourceLimit).toHaveBeenCalledWith(websiteId);
  });

  test('does not write when a visit or source budget is exhausted', async () => {
    prepareHeatmapRequest();
    vi.mocked(reserveHeatmapBudget).mockRejectedValueOnce(new HeatmapBudgetExceededError());
    const request = () =>
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      });

    expect((await POST(request())).status).toBe(413);
    expect(saveHeatmapEvents).not.toHaveBeenCalled();

    vi.mocked(reserveHeatmapBudget).mockRejectedValueOnce(new HeatmapBudgetExceededError(60));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('does not write heatmaps when the shared owner budget is exhausted', async () => {
    prepareHeatmapRequest();
    vi.mocked(reserveHeatmapBudget).mockRejectedValueOnce(new CollectionBudgetExceededError(60));

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('commits the budget before an external ClickHouse or Kafka write', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(withActiveCollectionSource).toHaveBeenCalledTimes(2);
    expect(reserveHeatmapBudget).toHaveBeenCalledOnce();
    expect(saveHeatmapEvents).toHaveBeenCalledWith(expect.any(Array));
    expect(vi.mocked(withActiveCollectionSource).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(saveHeatmapEvents).mock.invocationCallOrder[0],
    );
  });

  test('does not write to an external sink when the budget transaction fails to commit', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    vi.mocked(withActiveCollectionSource).mockImplementationOnce(async (_, __, operation) => {
      await operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { heatmapEnabled: true },
            userId: ACCOUNT_ID,
          }),
        },
      } as any);
      throw new Error('Synthetic transaction commit failure');
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(500);
    expect(reserveHeatmapBudget).toHaveBeenCalledOnce();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('does not write to an external sink after heatmap collection is disabled', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    vi.mocked(withActiveCollectionSource).mockImplementationOnce((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { heatmapEnabled: true },
            userId: ACCOUNT_ID,
          }),
        },
      } as any),
    );
    vi.mocked(withActiveCollectionSource).mockImplementationOnce((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { heatmapEnabled: false },
            userId: ACCOUNT_ID,
          }),
        },
      } as any),
    );

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'heatmap_disabled' });
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('does not write to an external sink after website ownership changes', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    let lookup = 0;
    vi.mocked(withActiveCollectionSource).mockImplementation((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockImplementation(async () => {
            lookup += 1;
            return {
              recorderEnabled: true,
              replayConfig: { heatmapEnabled: true },
              userId: lookup === 1 ? ACCOUNT_ID : null,
              teamId: lookup === 1 ? null : '55555555-5555-4555-8555-555555555555',
            };
          }),
        },
      } as any),
    );

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(409);
    expect(reserveHeatmapBudget).toHaveBeenCalledOnce();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });
});

describe('external replay budget commit', () => {
  const request = () =>
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token' },
    });

  test('commits the budget before an external replay write', async () => {
    prepareReplayRequest();
    clickhouseState.enabled = true;

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(reserveReplayBudget).toHaveBeenCalledOnce();
    expect(reserveReplayBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountType: 'user', accountId: ACCOUNT_ID }),
    );
    expect(withActiveCollectionSource).toHaveBeenCalledTimes(2);
    expect(saveRecording).toHaveBeenCalledWith(expect.objectContaining({ eventCount: 1 }));
    expect(vi.mocked(withActiveCollectionSource).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(saveRecording).mock.invocationCallOrder[0],
    );
  });

  test('rejects cumulative compact replay nodes before reserving or writing', async () => {
    const { websiteId } = prepareReplayRequest();
    const nodes = Array.from({ length: 30_000 }, () => ({}));
    parseRequestMock.mockResolvedValue({
      body: {
        type: 'record',
        payload: {
          website: websiteId,
          events: [
            { type: 2, data: { node: { childNodes: nodes } } },
            { type: 2, data: { node: { childNodes: nodes } } },
          ],
        },
      },
      error: undefined,
    });

    const response = await POST(request());

    expect(response.status).toBe(413);
    expect(reserveReplayBudget).not.toHaveBeenCalled();
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('accepts a replay event at the existing maximum nesting depth', async () => {
    const { websiteId } = prepareReplayRequest();
    let data: unknown = 0;

    for (let depth = 0; depth < 255; depth++) {
      data = [data];
    }

    parseRequestMock.mockResolvedValue({
      body: {
        type: 'record',
        payload: { website: websiteId, events: [{ type: 4, timestamp: Date.now(), data }] },
      },
      error: undefined,
    });

    expect((await POST(request())).status).toBe(200);
    expect(reserveReplayBudget).toHaveBeenCalledOnce();
  });

  test('keeps relational replay writes inside the budget transaction', async () => {
    prepareReplayRequest();

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(withActiveCollectionSource).toHaveBeenCalledOnce();
    expect(saveRecording).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
  });

  test('does not write replays when the shared owner budget is exhausted', async () => {
    prepareReplayRequest();
    vi.mocked(reserveReplayBudget).mockRejectedValueOnce(new CollectionBudgetExceededError(86_400));

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('86400');
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('never writes to an external sink when the budget transaction rolls back', async () => {
    prepareReplayRequest();
    clickhouseState.enabled = true;
    vi.mocked(withActiveCollectionSource).mockImplementationOnce(async (_, __, operation) => {
      await operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { replayEnabled: true },
            userId: ACCOUNT_ID,
          }),
        },
      } as any);
      throw new Error('Synthetic transaction commit failure');
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(500);
    expect(reserveReplayBudget).toHaveBeenCalledOnce();
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('does not write to an external sink after replay collection is disabled', async () => {
    prepareReplayRequest();
    clickhouseState.enabled = true;
    vi.mocked(withActiveCollectionSource).mockImplementationOnce((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { replayEnabled: true },
            userId: ACCOUNT_ID,
          }),
        },
      } as any),
    );
    vi.mocked(withActiveCollectionSource).mockImplementationOnce((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { replayEnabled: false },
            userId: ACCOUNT_ID,
          }),
        },
      } as any),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'replay_disabled' });
    expect(saveRecording).not.toHaveBeenCalled();
  });
});

describe('record route CORS', () => {
  test('handles preflight requests', async () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-umami-cache');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  test('includes CORS headers on post responses', async () => {
    parseRequestMock.mockResolvedValue({
      body: {
        type: 'record',
        payload: {
          website: '11111111-1111-4111-8111-111111111111',
          events: [],
        },
      },
      error: undefined,
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
