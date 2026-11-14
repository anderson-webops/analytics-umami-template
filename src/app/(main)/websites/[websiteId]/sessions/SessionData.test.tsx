import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { SessionData } from './SessionData';

const mockUseSessionDataQuery = vi.fn();

vi.mock('@/components/hooks', () => ({
  useSessionDataQuery: () => mockUseSessionDataQuery(),
}));

test('distinguishes authorized properties from historical and unknown provenance', () => {
  mockUseSessionDataQuery.mockReturnValue({
    data: [
      { dataKey: 'verified-by-backend', dataType: 1, stringValue: 'value', trustTier: 1 },
      { dataKey: 'historical', dataType: 1, stringValue: 'value', trustTier: 0 },
      { dataKey: 'unknown', dataType: 1, stringValue: 'value' },
    ],
    isLoading: false,
    error: undefined,
  });

  render(<SessionData websiteId="website" sessionId="session" />);

  expect(screen.getByText('Website backend authorized')).toBeInTheDocument();
  expect(screen.getAllByText('Unverified')).toHaveLength(2);
});

test('renders typed values while retaining strict provenance labels', () => {
  mockUseSessionDataQuery.mockReturnValue({
    data: [
      { dataKey: 'number', dataType: 2, numberValue: '123.5000', trustTier: 1 },
      { dataKey: 'date', dataType: 4, dateValue: '2026-11-14T12:00:00Z', trustTier: 0 },
      { dataKey: 'text', dataType: 1, stringValue: '<script>value</script>', trustTier: '1' },
    ],
    isLoading: false,
  });
  const { container } = render(<SessionData websiteId="website" sessionId="session" />);
  expect(screen.getByText('123.5')).toBeInTheDocument();
  expect(screen.getByText('2026-11-14T12:00:00.000Z')).toBeInTheDocument();
  expect(screen.getByText('<script>value</script>')).toBeInTheDocument();
  expect(screen.getByText('Website backend authorized')).toBeInTheDocument();
  expect(screen.getAllByText('Unverified')).toHaveLength(2);
  expect(container.querySelector('script')).toBeNull();
});
