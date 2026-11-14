import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';

const mockUseConfig = vi.fn();
const mockUseLoginQuery = vi.fn();
const mockUseNavigation = vi.fn();
const mockUseTeamQuery = vi.fn();
const mockUseTwoFactorStatusQuery = vi.fn();
const mockUseSubscription = vi.fn();

vi.mock('@/components/hooks', () => ({
  useConfig: () => mockUseConfig(),
  useLoginQuery: () => mockUseLoginQuery(),
  useNavigation: () => mockUseNavigation(),
  useTeamQuery: (...args: unknown[]) => mockUseTeamQuery(...args),
  useSubscription: (teamId: string | undefined) => mockUseSubscription(teamId),
  useTwoFactorStatusQuery: (enabled: boolean) => mockUseTwoFactorStatusQuery(enabled),
}));

vi.mock('@/app/(main)/MobileNav', () => ({
  MobileNav: () => <nav aria-label="Mobile navigation" />,
}));

vi.mock('@/app/(main)/SideNav', () => ({
  SideNav: () => <nav aria-label="Sidebar navigation" />,
}));

vi.mock('@/app/(main)/TopNav', () => ({
  TopNav: () => <header>Top navigation</header>,
}));

vi.mock('@/components/modals/TwoFactorSetupModal', () => ({
  TwoFactorSetupModal: () => <div>Two-factor setup</div>,
}));

vi.mock('@/components/modals/PasswordChangeRequiredModal', () => ({
  PasswordChangeRequiredModal: () => <div>Required password change</div>,
}));

vi.mock('@/lib/storage', () => ({
  removeItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('./UpdateNotice', () => ({
  UpdateNotice: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSubscription.mockReturnValue({ billingStatus: null, isOwner: false, isLoading: false });
  mockUseConfig.mockReturnValue({ cloudMode: false });
  mockUseLoginQuery.mockReturnValue({
    user: { id: 'admin-id', role: 'admin', username: 'admin' },
    isLoading: false,
    error: null,
  });
  mockUseNavigation.mockReturnValue({
    router: { replace: vi.fn() },
    teamId: undefined,
  });
  mockUseTeamQuery.mockReturnValue({ isLoading: false, error: null });
  mockUseTwoFactorStatusQuery.mockReturnValue({
    data: { isRequired: false, isEnabled: false },
  });
});

test('provides one main landmark for authenticated page content', () => {
  render(
    <App>
      <h1>Analytics overview</h1>
    </App>,
  );

  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(screen.getByRole('main')).toContainElement(
    screen.getByRole('heading', { name: 'Analytics overview' }),
  );
});

test('keeps required two-factor setup available while hiding the main content', () => {
  mockUseTwoFactorStatusQuery.mockReturnValue({
    data: { isRequired: true, isEnabled: false },
  });

  render(
    <App>
      <h1>Analytics overview</h1>
    </App>,
  );

  expect(screen.getByText('Two-factor setup')).toBeInTheDocument();
  expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('aria-hidden', 'true');
});

test('required password changes keep the main content blocked until the owner completes them', () => {
  mockUseLoginQuery.mockReturnValue({
    user: { id: 'user-1', passwordChangeRequired: true },
    isLoading: false,
    error: null,
  });
  render(<App>Private content</App>);

  expect(screen.getByText('Required password change')).toBeInTheDocument();
  expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('aria-hidden', 'true');
});

test('required factor setup remains first when a password change is also required', () => {
  mockUseLoginQuery.mockReturnValue({ user: { id: 'user-1', passwordChangeRequired: true } });
  mockUseTwoFactorStatusQuery.mockReturnValue({ data: { isRequired: true, isEnabled: false } });

  render(<App>Private content</App>);

  expect(screen.getByText('Two-factor setup')).toBeInTheDocument();
  expect(screen.queryByText('Required password change')).not.toBeInTheDocument();
});

test('a cloud team waits for subscription evidence before fetching private team data', () => {
  mockUseConfig.mockReturnValue({ cloudMode: true });
  mockUseNavigation.mockReturnValue({ teamId: 'team-1', router: { replace: vi.fn() } });
  mockUseSubscription.mockReturnValue({ isLoading: true, isOwner: false, billingStatus: null });

  render(<App>Private content</App>);

  expect(mockUseTeamQuery).toHaveBeenCalledWith('team-1', { enabled: false });
  expect(screen.queryByText('Private content')).not.toBeInTheDocument();
});

test('a past-due cloud team blocks member content without making a team-data request', () => {
  mockUseConfig.mockReturnValue({ cloudMode: true });
  mockUseNavigation.mockReturnValue({ teamId: 'team-1', router: { replace: vi.fn() } });
  mockUseSubscription.mockReturnValue({
    isLoading: false,
    isOwner: false,
    billingStatus: 'past_due',
  });

  render(<App>Private content</App>);

  expect(screen.getByText('This team is temporarily unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('Private content')).not.toBeInTheDocument();
  expect(mockUseTeamQuery).toHaveBeenCalledWith('team-1', { enabled: false });
});

test('self-hosted accounts retain access independently of cached cloud billing state', () => {
  mockUseNavigation.mockReturnValue({ teamId: 'team-1', router: { replace: vi.fn() } });
  mockUseSubscription.mockReturnValue({
    isLoading: true,
    isOwner: false,
    billingStatus: 'past_due',
  });

  render(<App>Private content</App>);

  expect(screen.getByText('Private content')).toBeInTheDocument();
  expect(mockUseTeamQuery).toHaveBeenCalledWith('team-1', { enabled: true });
});

test('a current cloud team retains access and ignores stale self-hosted factor requirements', () => {
  mockUseConfig.mockReturnValue({ cloudMode: true });
  mockUseNavigation.mockReturnValue({ teamId: 'team-1', router: { replace: vi.fn() } });
  mockUseTwoFactorStatusQuery.mockReturnValue({ data: { isRequired: true, isEnabled: false } });

  render(<App>Private content</App>);

  expect(screen.getByText('Private content')).toBeInTheDocument();
  expect(screen.queryByText('Two-factor setup')).not.toBeInTheDocument();
  expect(mockUseTwoFactorStatusQuery).toHaveBeenCalledWith(false);
  expect(mockUseTeamQuery).toHaveBeenCalledWith('team-1', { enabled: true });
});
