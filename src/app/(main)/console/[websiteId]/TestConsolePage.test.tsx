import { afterEach, expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { TestConsolePage } from './TestConsolePage';

vi.mock('next/script', () => ({ default: () => null }));
vi.mock('@/components/hooks', async importOriginal => ({
  ...(await importOriginal<typeof import('@/components/hooks')>()),
  useWebsiteQuery: () => ({ data: { name: 'Test website' } }),
}));
vi.mock('@/app/(main)/websites/[websiteId]/WebsiteChart', () => ({
  WebsiteChart: () => null,
}));
vi.mock('@/components/metrics/EventsChart', () => ({
  EventsChart: () => null,
}));

afterEach(() => vi.unstubAllGlobals());

test('the browser console offers only an unverified pageview submission', async () => {
  const track = vi.fn();
  vi.stubGlobal('umami', { track });

  const { user } = render(<TestConsolePage websiteId="test-website" />);

  expect(screen.getByText(/browser console sends unverified pageviews only/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /revenue|identify|event/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Run pageview script' }));

  expect(track).toHaveBeenCalledTimes(1);
  const [pageview] = track.mock.calls[0];
  expect(pageview({ website: 'test-website' })).toEqual({
    website: 'test-website',
    url: '/page-view',
    referrer: 'https://www.google.com',
  });
});
