import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { EventData } from './EventData';

const mockUseEventDataQuery = vi.fn();

vi.mock('@/components/hooks', () => ({
  useEventDataQuery: () => mockUseEventDataQuery(),
}));

test('labels legacy and unknown event properties as unverified', () => {
  mockUseEventDataQuery.mockReturnValue({
    data: [
      { dataKey: 'authorized', stringValue: 'value', trustTier: 1 },
      { dataKey: 'legacy', stringValue: 'value', trustTier: 0 },
      { dataKey: 'unknown', stringValue: 'value' },
    ],
    isLoading: false,
    error: undefined,
  });

  render(<EventData websiteId="website" eventId="event" />);

  expect(screen.getByText('Website backend authorized')).toBeInTheDocument();
  expect(screen.getAllByText('Unverified')).toHaveLength(2);
});
