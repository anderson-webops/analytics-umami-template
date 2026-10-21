import { expect, test, vi } from 'vitest';
import { getRealtimeActivity } from '@/queries/sql/getRealtimeActivity';
import { getPageviewStats } from '@/queries/sql/pageviews/getPageviewStats';
import { getSessionStats } from '@/queries/sql/sessions/getSessionStats';
import { getRealtimeData } from './getRealtimeData';

vi.mock('@/queries/sql/getRealtimeActivity', () => ({ getRealtimeActivity: vi.fn() }));
vi.mock('@/queries/sql/pageviews/getPageviewStats', () => ({ getPageviewStats: vi.fn() }));
vi.mock('@/queries/sql/sessions/getSessionStats', () => ({ getSessionStats: vi.fn() }));

test('real-time traffic keeps unverified public provenance beside aggregate results', async () => {
  vi.mocked(getRealtimeActivity).mockResolvedValue([
    {
      sessionId: 'public-session',
      eventName: '',
      createdAt: '2026-10-21T12:00:00Z',
      browser: 'Chrome',
      os: 'macOS',
      device: 'desktop',
      country: 'US',
      urlPath: '/public',
      referrerDomain: '',
      hostname: 'example.test',
    },
  ]);
  vi.mocked(getPageviewStats).mockResolvedValue([{ x: '2026-10-21T12:00:00Z', y: 3 }]);
  vi.mocked(getSessionStats).mockResolvedValue([{ x: '2026-10-21T12:00:00Z', y: 2 }]);

  const result = await getRealtimeData('website', {});

  expect(result.trafficProvenance).toBe('may_include_unverified_public_observations');
  expect(result.totals).toMatchObject({ views: 3, visitors: 2, events: 0, countries: 1 });
  expect(result.events.map(event => event.__type)).toEqual(['pageview', 'session']);
});
