import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';

const mockUseConfig = vi.fn();
const mockUseLoginQuery = vi.fn();
const mockUseNavigation = vi.fn();
const mockUseTeamQuery = vi.fn();
const mockUseTwoFactorStatusQuery = vi.fn();

vi.mock('@/components/hooks', () => ({
  useConfig: () => mockUseConfig(),
  useLoginQuery: () => mockUseLoginQuery(),
  useNavigation: () => mockUseNavigation(),
  useTeamQuery: (teamId: string | undefined) => mockUseTeamQuery(teamId),
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

vi.mock('@/lib/storage', () => ({
  removeItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('./UpdateNotice', () => ({
  UpdateNotice: () => null,
}));

beforeEach(() => {
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
