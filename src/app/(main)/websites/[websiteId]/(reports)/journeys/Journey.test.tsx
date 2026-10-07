import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { Journey } from './Journey';

vi.mock('@/components/hooks', () => ({
  useEscapeKey: vi.fn(),
  useJourneyQuery: () => ({
    data: [
      { items: ['__proto__'], count: 2 },
      { items: ['__proto__'], count: 3 },
      { items: ['constructor'], count: 1 },
      { items: ['prototype'], count: 4 },
      { items: ['ordinary'], count: 2 },
    ],
    error: null,
    isLoading: false,
  }),
  useMessages: () => ({
    t: (value: string) => value,
    labels: { visitors: 'visitors', dropoff: 'dropoff', conversion: 'conversion' },
  }),
}));

test('Journey aggregates stored prototype-shaped event names without modifying Object.prototype', () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'totalCount');

  try {
    render(
      <Journey
        websiteId="website-1"
        startDate={new Date('2026-10-01T00:00:00.000Z')}
        endDate={new Date('2026-10-02T00:00:00.000Z')}
        steps={1}
        view="events"
      />,
    );

    expect(Object.hasOwn(Object.prototype, 'totalCount')).toBe(false);
    expect(screen.getByText('__proto__')).toBeInTheDocument();
    expect(screen.getByText('constructor')).toBeInTheDocument();
    expect(screen.getByText('prototype')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('12 visitors')).toBeInTheDocument();
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, 'totalCount', previous);
    } else {
      Reflect.deleteProperty(Object.prototype, 'totalCount');
    }
  }
});
