import { beforeEach, describe, expect, test, vi } from 'vitest';

const findWebsite = vi.fn();

vi.mock('@/queries/prisma', () => ({
  findWebsite,
}));

const { GET } = await import('./route');

const WEBSITE_ID = '1087d7c0-1bfb-4f45-8de8-1413af30f280';

function request(origin = 'https://example.com') {
  return new Request(`https://analytics.example.net/api/websites/${WEBSITE_ID}/recorder`, {
    headers: {
      Origin: origin,
    },
  });
}

describe('public recorder configuration', () => {
  beforeEach(() => {
    findWebsite.mockReset();
    findWebsite.mockResolvedValue({
      id: WEBSITE_ID,
      domain: 'example.com',
      deletedAt: null,
      recorderEnabled: true,
      replayConfig: {
        replayEnabled: true,
        sampleRate: 0.5,
        maxDuration: 300_000,
      },
    });
  });

  test('returns configuration only to the configured website origin', async () => {
    const response = await GET(request(), {
      params: Promise.resolve({ websiteId: WEBSITE_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      replayEnabled: true,
      sampleRate: 0.5,
      maxDuration: 300_000,
    });
    expect(findWebsite).toHaveBeenCalledWith({
      where: {
        id: WEBSITE_ID,
        deletedAt: null,
      },
    });
  });

  test('does not reveal configuration to another origin', async () => {
    const response = await GET(request('https://attacker.example'), {
      params: Promise.resolve({ websiteId: WEBSITE_ID }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  test('rejects malformed website identifiers before querying', async () => {
    const response = await GET(request(), {
      params: Promise.resolve({ websiteId: 'not-a-uuid' }),
    });

    expect(response.status).toBe(404);
    expect(findWebsite).not.toHaveBeenCalled();
  });
});
