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

test('renders typed event properties without upgrading unverified values', () => {
  mockUseEventDataQuery.mockReturnValue({
    data: [
      { dataKey: 'number', dataType: 2, numberValue: '42.5000', trustTier: 1 },
      { dataKey: 'date', dataType: 4, dateValue: '2026-11-14T12:00:00Z', trustTier: 0 },
    ],
    isLoading: false,
  });
  render(<EventData websiteId="website" eventId="event" />);
  expect(screen.getByText('42.5')).toBeInTheDocument();
  expect(screen.getByText('2026-11-14T12:00:00.000Z')).toBeInTheDocument();
  expect(screen.getByText('Website backend authorized')).toBeInTheDocument();
  expect(screen.getByText('Unverified')).toBeInTheDocument();
});
