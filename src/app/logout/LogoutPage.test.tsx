import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { LogoutPage } from './LogoutPage';

const mocks = vi.hoisted(() => ({
  post: vi.fn(() => new Promise(() => {})),
  removeClientAuthToken: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('@/components/hooks/useApi', () => ({ useApi: () => ({ post: mocks.post }) }));
vi.mock('@/lib/client', () => ({ removeClientAuthToken: mocks.removeClientAuthToken }));
vi.mock('@/store/app', () => ({ setUser: mocks.setUser }));
vi.mock('@/components/hooks', () => ({
  useMessages: () => ({ t: (value: string) => value, labels: { logout: 'Logout' } }),
}));

test('navigating to the logout page does not end a session until the user confirms', async () => {
  mocks.post.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.removeClientAuthToken.mockClear();
  mocks.setUser.mockClear();
  const { user, rerender } = render(<LogoutPage />, { route: '/logout' });

  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.removeClientAuthToken).not.toHaveBeenCalled();
  expect(mocks.setUser).not.toHaveBeenCalled();
  rerender(<LogoutPage />);
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.removeClientAuthToken).not.toHaveBeenCalled();
  expect(mocks.setUser).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Logout' }));
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/auth/logout');
  expect(mocks.removeClientAuthToken).not.toHaveBeenCalled();
  expect(mocks.setUser).not.toHaveBeenCalled();
});

test('a failed logout leaves local sign-in state intact', async () => {
  mocks.post.mockReset().mockRejectedValueOnce(new Error('synthetic failure'));
  mocks.removeClientAuthToken.mockClear();
  mocks.setUser.mockClear();
  const { user } = render(<LogoutPage />, { route: '/logout' });

  await user.click(screen.getByRole('button', { name: 'Logout' }));

  expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/auth/logout');
  expect(mocks.removeClientAuthToken).not.toHaveBeenCalled();
  expect(mocks.setUser).not.toHaveBeenCalled();
  expect(await screen.findByText('Something went wrong.')).toBeInTheDocument();
});

test('an explicit successful logout clears local sign-in state', async () => {
  mocks.post.mockReset().mockResolvedValueOnce({});
  mocks.removeClientAuthToken.mockClear();
  mocks.setUser.mockClear();
  const { user } = render(<LogoutPage />, { route: '/logout' });
  window.history.replaceState({}, '', '/login');

  await user.click(screen.getByRole('button', { name: 'Logout' }));

  expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/auth/logout');
  expect(mocks.removeClientAuthToken).toHaveBeenCalledOnce();
  expect(mocks.setUser).toHaveBeenCalledExactlyOnceWith(null);
});
