import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { BoardRealtimeActiveUsers } from '@/app/(main)/websites/[websiteId]/realtime/BoardRealtimeActiveUsers';
import { ActiveUsers } from './ActiveUsers';

vi.mock('@/components/hooks', () => ({
  useActiveUsersQuery: () => ({
    data: { visitors: 7, trafficProvenance: 'may_include_unverified_public_observations' },
    isLoading: false,
    error: null,
  }),
  useMessages: () => ({ t: (value: string) => value, labels: { sessions: 'sessions' } }),
}));

vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

test('compact realtime count describes sessions rather than verified people online', () => {
  render(<ActiveUsers websiteId="website" allowLink={false} />);

  expect(screen.getByText('7 sessions')).toBeInTheDocument();
  expect(screen.queryByText(/online/i)).not.toBeInTheDocument();
});

test('realtime board keeps the public-observation limitation visible', () => {
  render(<BoardRealtimeActiveUsers websiteId="website" />);

  expect(screen.getByText('7')).toBeInTheDocument();
  expect(screen.getByText('sessions')).toBeInTheDocument();
  expect(screen.getByText('May include unverified public activity.')).toBeInTheDocument();
});
