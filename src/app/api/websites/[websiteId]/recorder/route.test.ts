import { beforeEach, describe, expect, test, vi } from 'vitest';
import { findWebsite } from '@/queries/prisma';
import { GET, OPTIONS } from './route';

vi.mock('@/queries/prisma', () => ({
  findWebsite: vi.fn(),
}));

const findWebsiteMock = vi.mocked(findWebsite);
const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recorder config route CORS', () => {
  test('handles preflight requests', async () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-umami-cache');
  });

  test('allows the configured tracking origin on config responses', async () => {
    findWebsiteMock.mockResolvedValue({
      id: WEBSITE_ID,
      domain: 'example.com',
      recorderEnabled: false,
    } as any);

    const response = await GET(
      new Request(`http://localhost/api/websites/${WEBSITE_ID}/recorder`, {
        headers: { Origin: 'https://example.com' },
      }),
      {
        params: Promise.resolve({ websiteId: WEBSITE_ID }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(response.headers.get('Cache-Control')).toContain('max-age=60');
  });

  test('does not expose configuration to an unrelated origin', async () => {
    findWebsiteMock.mockResolvedValue({
      id: WEBSITE_ID,
      domain: 'example.com',
      recorderEnabled: true,
      replayConfig: {},
    } as any);

    const response = await GET(
      new Request(`http://localhost/api/websites/${WEBSITE_ID}/recorder`, {
        headers: { Origin: 'https://attacker.example' },
      }),
      {
        params: Promise.resolve({ websiteId: WEBSITE_ID }),
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
