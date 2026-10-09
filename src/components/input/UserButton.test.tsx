import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { UserButton } from './UserButton';

const mocks = vi.hoisted(() => ({ logout: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/hooks/useLogout', () => ({ useLogout: () => mocks.logout }));

vi.mock('@/components/hooks', () => ({
  useConfig: () => ({ cloudMode: false }),
  useLocale: () => ({ locale: 'en-US', saveLocale: vi.fn() }),
  useLoginQuery: () => ({ user: { username: 'admin', isAdmin: false } }),
  useMessages: () => ({
    t: (value: string) => value,
    labels: {
      admin: 'Admin',
      documentation: 'Documentation',
      language: 'Language',
      logout: 'Logout',
      profile: 'Profile',
      settings: 'Settings',
      support: 'Support',
      theme: 'Theme',
    },
  }),
  useMobile: () => ({ isMobile: false }),
}));

test('renders the expanded sidebar control at full width and opens its menu', async () => {
  const { user } = render(<UserButton />);
  const button = screen.getByRole('button', { name: 'Profile' });

  expect(button).toHaveStyle({ width: '100%' });

  button.focus();
  await user.keyboard('{Enter}');

  expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
});

test('keeps the collapsed sidebar control accessible and interactive', async () => {
  const { user } = render(<UserButton showText={false} />);
  const button = screen.getByRole('button', { name: 'Profile' });

  button.focus();
  await user.keyboard('{Enter}');

  expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
});

test('closes the menu after selecting settings', async () => {
  const { user } = render(<UserButton />);
  const button = screen.getByRole('button', { name: 'Profile' });

  button.focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'Settings' }));

  expect(screen.queryByRole('menuitem', { name: 'Settings' })).not.toBeInTheDocument();
});

test('logs out directly from the menu without navigating to the logout page', async () => {
  mocks.logout.mockClear();
  const { user } = render(<UserButton />);
  const button = screen.getByRole('button', { name: 'Profile' });

  button.focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'Logout' }));

  expect(mocks.logout).toHaveBeenCalledOnce();
});
