import { beforeEach, expect, test, vi } from 'vitest';
import { AUTH_TOKEN } from '@/lib/constants';
import { render, screen, waitFor } from '@/test/render';
import { PasswordEditForm } from './PasswordEditForm';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), change: vi.fn(), storageWrite: vi.fn() }));
const codes = Array.from({ length: 8 }, (_, index) => `UR-${(index + 1).toString(16).repeat(64)}`);

vi.mock('@/components/hooks', async () => {
  const { useMessages } = await vi.importActual<typeof import('@/components/hooks/useMessages')>(
    '@/components/hooks/useMessages',
  );

  return {
    useMessages,
    useUpdateQuery: (url: string) => ({
      mutateAsync: url === '/me/password' ? mocks.change : mocks.prepare,
      error: null,
      isPending: false,
    }),
  };
});

beforeEach(() => {
  mocks.storageWrite.mockReset();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(mocks.storageWrite);
  mocks.prepare.mockReset().mockResolvedValue({ recoveryCodes: codes });
  mocks.change.mockReset().mockImplementation(async (_data, { onSuccess }) => {
    await onSuccess({ id: 'user-1', token: 'new-session-token' });
  });
});

async function prepareChange(user: ReturnType<typeof render>['user']) {
  await user.type(await screen.findByLabelText('Current password'), 'synthetic-current-password');
  await user.type(screen.getByLabelText('New password'), 'synthetic-new-password');
  await user.type(screen.getByLabelText('Confirm password'), 'synthetic-new-password');
  await user.click(screen.getByRole('button', { name: 'Prepare recovery codes' }));
  await waitFor(() => expect(screen.getByText(codes[0])).toBeVisible());
}

async function confirmChange(user: ReturnType<typeof render>['user']) {
  await user.click(screen.getByRole('checkbox', { name: 'I saved these codes' }));
  await user.type(screen.getByLabelText('Code from your saved copy'), codes[0]);
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

test('completes cookie-authenticated password replacement only after saved-copy proof', async () => {
  const onSave = vi.fn();
  const { user } = render(<PasswordEditForm onSave={onSave} required={true} />);
  await prepareChange(user);

  expect(mocks.change).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

  await confirmChange(user);

  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(mocks.storageWrite).not.toHaveBeenCalledWith(AUTH_TOKEN, expect.anything());
  expect(mocks.change).toHaveBeenCalledWith(
    {
      currentPassword: 'synthetic-current-password',
      newPassword: 'synthetic-new-password',
      recoveryCode: codes[0],
      saved: true,
    },
    expect.any(Object),
  );
  expect(mocks.change.mock.invocationCallOrder[0]).toBeLessThan(onSave.mock.invocationCallOrder[0]);
});

test('a cookie-authenticated response without a body token completes without client token storage', async () => {
  mocks.change.mockImplementation(async (_data, { onSuccess }) => {
    await onSuccess({ id: 'user-1' });
  });
  const onSave = vi.fn();
  const { user } = render(<PasswordEditForm onSave={onSave} required={true} />);
  await prepareChange(user);
  await confirmChange(user);

  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(mocks.storageWrite).not.toHaveBeenCalledWith(AUTH_TOKEN, expect.anything());
});

test('a required password change stays uncancellable before and after preparation', async () => {
  const { user } = render(<PasswordEditForm onSave={vi.fn()} required={true} />);

  expect(await screen.findByRole('button', { name: 'Prepare recovery codes' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  await prepareChange(user);
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
});

test('a rejected password change keeps recovery proof visible without reporting success', async () => {
  mocks.change.mockRejectedValue(new Error('Synthetic expired preparation'));
  const onSave = vi.fn();
  const { user } = render(<PasswordEditForm onSave={onSave} required={true} />);
  await prepareChange(user);
  await confirmChange(user);

  await waitFor(() => expect(mocks.change).toHaveBeenCalledOnce());
  expect(screen.getByText(codes[0])).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
  expect(mocks.storageWrite).not.toHaveBeenCalledWith(AUTH_TOKEN, expect.anything());
});

test('client validation retains the server minimum before preparing recovery codes', async () => {
  const { user } = render(<PasswordEditForm onSave={vi.fn()} required={true} />);
  await user.type(await screen.findByLabelText('Current password'), 'synthetic-current-password');
  await user.type(screen.getByLabelText('New password'), 'short-value');
  await user.type(screen.getByLabelText('Confirm password'), 'short-value');
  await user.click(screen.getByRole('button', { name: 'Prepare recovery codes' }));

  await waitFor(() =>
    expect(screen.getAllByText('Minimum length of 12 characters').length).toBeGreaterThan(0),
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.change).not.toHaveBeenCalled();
});
