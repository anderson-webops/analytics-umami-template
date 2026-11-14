import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { Journey } from './Journey';

const state = vi.hoisted(() => ({ data: [] as { items: string[]; count: number }[] }));
vi.mock('@/components/hooks', () => ({
  useEscapeKey: vi.fn(),
  useJourneyQuery: () => ({ data: state.data, error: null, isLoading: false }),
  useMessages: () => ({
    t: (value: string) => value,
    labels: { step: 'Step', visits: 'visits', dropoff: 'Dropoff', conversion: 'Conversion' },
  }),
}));
beforeEach(() => {
  state.data = [
    { items: ['__proto__'], count: 2 },
    { items: ['__proto__'], count: 3 },
    { items: ['constructor'], count: 1 },
    { items: ['prototype'], count: 4 },
    { items: ['ordinary'], count: 2 },
  ];
});

test('Journey aggregates stored prototype-shaped event names without modifying Object.prototype', () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'totalCount');
  try {
    render(
      <Journey
        websiteId="website-1"
        startDate={new Date('2026-10-01T00:00:00Z')}
        endDate={new Date('2026-10-02T00:00:00Z')}
        steps={1}
        view="events"
      />,
    );
    expect(Object.hasOwn(Object.prototype, 'totalCount')).toBe(false);
    expect(screen.getByText('__proto__')).toBeInTheDocument();
    expect(screen.getByText('constructor')).toBeInTheDocument();
    expect(screen.getByText('prototype')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('12 visits')).toBeInTheDocument();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'totalCount', previous);
    else Reflect.deleteProperty(Object.prototype, 'totalCount');
  }
});

test('sorts each step by total visitors with alphabetical tie-breaking', () => {
  state.data = [
    { items: ['/contact', '/thank-you'], count: 4 },
    { items: ['/', '/pricing'], count: 100 },
    { items: ['/about', '/team'], count: 25 },
    { items: ['/blog', '/pricing'], count: 50 },
    { items: ['/beta', '/next'], count: 10 },
    { items: ['/alpha', '/next'], count: 10 },
  ];
  const { container } = render(
    <Journey
      websiteId="website-1"
      steps={2}
      startDate={new Date('2026-07-01T00:00:00Z')}
      endDate={new Date('2026-07-31T23:59:59Z')}
      view="views"
    />,
  );
  const columns = container.querySelectorAll('[class*="column"]');
  expect(columns.length).toBeGreaterThanOrEqual(2);
  const names = (index: number) =>
    Array.from(
      columns[index].querySelector('[class*="nodes"]').querySelectorAll('[class*="name"]'),
    ).map(element => element.getAttribute('title'));
  expect(names(0)).toEqual(['/', '/blog', '/about', '/alpha', '/beta', '/contact']);
  expect(names(1)).toEqual(['/pricing', '/team', '/next', '/thank-you']);
});
