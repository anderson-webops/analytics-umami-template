import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { TwoFactorSetupModal } from './TwoFactorSetupModal';
import { TwoFactorSuccessModal } from './TwoFactorSuccessModal';

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    labels: new Proxy({}, { get: (_, key) => String(key) }),
    messages: new Proxy({}, { get: (_, key) => String(key) }),
    getErrorMessage: () => undefined,
  }),
  useUpdateQuery: (path: string) =>
    path.endsWith('/initiate')
      ? {
          mutate: (_: unknown, options: { onSuccess: (data: unknown) => void }) =>
            options.onSuccess({
              qrCodeDataUrl: 'data:image/png;base64,SYNTHETIC-TOTP-QR',
              manualKey: 'SYNTHETIC-TOTP-KEY',
            }),
        }
      : { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
}));

test('the enrollment dialog blocks its QR image and manual key from replay', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TwoFactorSetupModal required={true} />
    </QueryClientProvider>,
  );

  const manualKey = await screen.findByText('SYNTHETIC-TOTP-KEY');
  const privateDialog = manualKey.closest('.rr-block');
  expect(privateDialog).not.toBeNull();
  expect(privateDialog?.querySelector('img')).toHaveAttribute(
    'src',
    'data:image/png;base64,SYNTHETIC-TOTP-QR',
  );
});

test('the recovery-code dialog blocks displayed codes from replay', () => {
  render(<TwoFactorSuccessModal backupCodes={['SYNTHETIC-RECOVERY-CODE']} onClose={vi.fn()} />);

  expect(screen.getByText('SYNTHETIC-RECOVERY-CODE').closest('.rr-block')).not.toBeNull();
});
