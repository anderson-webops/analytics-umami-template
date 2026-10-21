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
