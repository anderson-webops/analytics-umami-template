import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getCollectionLimit } from '@/lib/collection-rate-limit';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { HeatmapBudgetExceededError, reserveHeatmapBudget } from '@/lib/heatmap-budget';
import { parseToken } from '@/lib/jwt';
import { parseRequest } from '@/lib/request';
import { getWebsite, withActiveCollectionSource } from '@/queries/prisma';
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
  getCollectionLimit: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  clickhouseState.enabled = false;
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
        replayConfig: { heatmapEnabled: true },
      }),
    },
  };

  vi.stubEnv('APP_SECRET', 'synthetic-test-secret-00000000000000000');
  vi.mocked(getCollectionLimit).mockResolvedValue({ blocked: false, retryAfter: 60 });
  vi.mocked(getClientInfo).mockResolvedValue({ ip: '127.0.0.1' } as any);
  vi.mocked(hasBlockedIp).mockReturnValue(false);
  vi.mocked(parseToken).mockResolvedValue({
    type: 'cache',
    websiteId,
    sessionId,
    visitId,
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

  return { websiteId, visitId };
}

describe('heatmap intake budget', () => {
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
      expect.objectContaining({ websiteId, visitId, events: 1 }),
    );
    expect(saveHeatmapEvents).toHaveBeenCalledOnce();
    expect(vi.mocked(reserveHeatmapBudget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(saveHeatmapEvents).mock.invocationCallOrder[0],
    );
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
