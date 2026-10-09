import { act } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { LoginForm } from './LoginForm';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  getError: vi.fn(),
  renderCaptcha: vi.fn(),
  resetCaptcha: vi.fn(),
  removeCaptcha: vi.fn(),
}));

vi.mock('next/script', () => ({
  default: ({ onReady, onError }: { onReady: () => void; onError: () => void }) => (
    <>
      <button type="button" onClick={onReady}>
        Load verification
      </button>
      <button type="button" onClick={onError}>
        Fail verification script
      </button>
    </>
  ),
}));

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    labels: { username: 'Username', password: 'Password', login: 'Log in', required: 'Required' },
    getErrorMessage: () => undefined,
  }),
  useUpdateQuery: () => ({ mutateAsync: mocks.mutateAsync, error: mocks.getError() }),
}));

vi.mock('@/components/svg', () => ({ Logo: () => null }));

async function enterCredentials(user: ReturnType<typeof render>['user']) {
  await user.type(screen.getByLabelText('Username'), 'alice');
  await user.type(screen.getByLabelText('Password'), 'correct-password');
}

test('configured login waits for a challenge and resets it after password submission', async () => {
  mocks.mutateAsync.mockReset().mockResolvedValue({});
  mocks.getError.mockReset().mockReturnValue(null);
  mocks.renderCaptcha.mockReset().mockReturnValue('widget-1');
  mocks.resetCaptcha.mockReset();
  mocks.removeCaptcha.mockReset();
  Object.assign(window, {
    turnstile: {
      render: mocks.renderCaptcha,
      reset: mocks.resetCaptcha,
      remove: mocks.removeCaptcha,
    },
  });

  const { user, unmount } = render(<LoginForm captchaSiteKey="public-test-key" />, {
    route: '/login',
  });

  await enterCredentials(user);
  const submit = screen.getByRole('button', { name: 'Log in' });
  expect(submit).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Load verification' }));

  const options = mocks.renderCaptcha.mock.calls[0][1];
  expect(options).toMatchObject({ sitekey: 'public-test-key', action: 'login' });
  act(() => options.callback('single-use-token'));
  expect(submit).toBeEnabled();

  await user.click(submit);
  await waitFor(() =>
    expect(mocks.mutateAsync).toHaveBeenCalledWith(
      { username: 'alice', password: 'correct-password', captchaToken: 'single-use-token' },
      expect.any(Object),
    ),
  );
  expect(mocks.resetCaptcha).toHaveBeenCalledWith('widget-1');
  expect(submit).toBeDisabled();

  unmount();
  expect(mocks.removeCaptcha).toHaveBeenCalledWith('widget-1');
  delete (window as Window & { turnstile?: unknown }).turnstile;
});

test('unconfigured login retains the existing password-only form', async () => {
  mocks.mutateAsync.mockReset().mockResolvedValue({});
  mocks.getError.mockReset().mockReturnValue(null);
  const { user } = render(<LoginForm />, { route: '/login' });

  await enterCredentials(user);
  expect(screen.queryByRole('button', { name: 'Load verification' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Log in' }));

  await waitFor(() =>
    expect(mocks.mutateAsync).toHaveBeenCalledWith(
      { username: 'alice', password: 'correct-password' },
      expect.any(Object),
    ),
  );
});

test('a failed verification script keeps login disabled and explains the failure', async () => {
  mocks.mutateAsync.mockReset();
  mocks.getError.mockReset().mockReturnValue(null);
  const { user } = render(<LoginForm captchaSiteKey="public-test-key" />, {
    route: '/login',
  });

  await user.click(screen.getByRole('button', { name: 'Fail verification script' }));

  expect(screen.getByRole('button', { name: 'Log in' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Login verification is unavailable');
  expect(mocks.mutateAsync).not.toHaveBeenCalled();
});

test('a rejected challenge displays the safe server message', () => {
  mocks.getError
    .mockReset()
    .mockReturnValue(
      Object.assign(new Error('Complete login verification'), { code: 'captcha-required' }),
    );

  render(<LoginForm captchaSiteKey="public-test-key" />, { route: '/login' });

  expect(screen.getByText('Complete login verification')).toBeInTheDocument();
});
