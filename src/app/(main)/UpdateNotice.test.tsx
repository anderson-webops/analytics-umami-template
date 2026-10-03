import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { REPO_URL } from '@/lib/constants';
import { UpdateNotice } from './UpdateNotice';

const mockUseVersion = vi.fn();

vi.mock('@umami/react-zen', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Column: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Row: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    labels: { viewDetails: 'View details', dismiss: 'Dismiss' },
    messages: { newVersionAvailable: 'New version available' },
  }),
}));

vi.mock('@/lib/storage', () => ({
  setItem: vi.fn(),
}));

vi.mock('@/store/version', () => ({
  checkVersion: vi.fn(),
  useVersion: () => mockUseVersion(),
}));

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  mockUseVersion.mockReturnValue({
    latest: '2.0.0',
    checked: false,
    hasUpdate: true,
    releaseUrl: null,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test.each([
  [
    'https://github.com/umami-software/umami/releases/tag/v2.0.0',
    'https://github.com/umami-software/umami/releases/tag/v2.0.0',
  ],
  [null, REPO_URL],
])('opens update details safely when release URL is %s', (releaseUrl, expectedUrl) => {
  const open = vi.fn();
  vi.stubGlobal('open', open);
  mockUseVersion.mockReturnValue({
    latest: '2.0.0',
    checked: false,
    hasUpdate: true,
    releaseUrl,
  });

  render(<UpdateNotice user={{ isAdmin: true }} config={{}} />);
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));

  expect(open).toHaveBeenCalledWith(expectedUrl, '_blank', 'noopener,noreferrer');
});
