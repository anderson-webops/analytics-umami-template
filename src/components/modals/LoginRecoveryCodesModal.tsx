'use client';
import {
  Button,
  Column,
  Dialog,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  Modal,
  PasswordField,
  Text,
  TextField,
} from '@umami/react-zen';
import { useState } from 'react';
import { ControlledDialog } from '@/components/common/ControlledDialog';
import { useMessages, useUpdateQuery } from '@/components/hooks';

export function LoginRecoveryCodesModal({
  onClose,
  onRotated,
  target,
}: {
  onClose: () => void;
  onRotated?: () => void;
  target?: { id: string; username: string };
}) {
  const { t, labels, getErrorMessage } = useMessages();
  const { mutateAsync, error, isPending } = useUpdateQuery('/auth/recovery-codes');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async ({ password }: { password: string }) => {
    const response = await mutateAsync({
      action: 'prepare',
      password,
      ...(target ? { userId: target.id } : {}),
    }).catch(() => null);
    if (!response) return;
    setCodes(response.recoveryCodes);
  };

  const handleConfirm = async ({
    password,
    recoveryCode,
  }: {
    password: string;
    recoveryCode: string;
  }) => {
    if (!saved) return;
    const response = await mutateAsync({
      action: 'confirm',
      password,
      recoveryCode,
      saved: true,
    }).catch(() => null);
    if (response?.confirmed !== true) return;
    onRotated?.();
    onClose();
  };

  return (
    <ControlledDialog>
      <Modal isOpen={true} onOpenChange={onClose}>
        <Dialog
          title={target ? 'Issue login recovery codes' : 'Login recovery codes'}
          className="rr-block"
          style={{ maxWidth: '95vw' }}
        >
          {codes ? (
            <Column gap="4">
              <Text>
                {target
                  ? `Give these to ${target.username} privately. The owner must confirm a code in Security within 15 minutes. Previous codes remain active until then.`
                  : 'Save the codes, then confirm one within 15 minutes. Confirmation spends that code and activates the unused codes. Previous codes remain active until confirmation.'}
              </Text>
              <Column gap="2">
                {codes.map(code => (
                  <code key={code} style={{ overflowWrap: 'anywhere', userSelect: 'all' }}>
                    {code}
                  </code>
                ))}
              </Column>
              <label>
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={event => setSaved(event.target.checked)}
                />{' '}
                {target ? 'I delivered these codes' : 'I saved these codes'}
              </label>
              {target ? (
                <FormButtons>
                  <Button variant="primary" onPress={onClose} isDisabled={!saved}>
                    {t(labels.close)}
                  </Button>
                </FormButtons>
              ) : (
                <Form
                  onSubmit={handleConfirm}
                  error={getErrorMessage(error)}
                  defaultValues={{ password: '', recoveryCode: '' }}
                >
                  <FormField
                    label={t(labels.currentPassword)}
                    name="password"
                    rules={{ required: t(labels.required) }}
                  >
                    <PasswordField autoComplete="current-password" />
                  </FormField>
                  <FormField
                    label="Code from your saved copy"
                    name="recoveryCode"
                    rules={{ required: t(labels.required) }}
                  >
                    <TextField autoComplete="off" spellCheck={false} />
                  </FormField>
                  <FormButtons>
                    <Button onPress={onClose} isDisabled={isPending}>
                      {t(labels.cancel)}
                    </Button>
                    <FormSubmitButton variant="primary" isDisabled={!saved || isPending}>
                      Confirm codes
                    </FormSubmitButton>
                  </FormButtons>
                </Form>
              )}
            </Column>
          ) : (
            <Form
              onSubmit={handleSubmit}
              error={getErrorMessage(error)}
              defaultValues={{ password: '' }}
            >
              <Text>Previous codes stay active until the owner confirms the replacement.</Text>
              <FormField
                label={t(labels.currentPassword)}
                name="password"
                rules={{ required: t(labels.required) }}
              >
                <PasswordField autoComplete="current-password" />
              </FormField>
              <FormButtons>
                <Button onPress={onClose} isDisabled={isPending}>
                  {t(labels.cancel)}
                </Button>
                <FormSubmitButton variant="primary" isDisabled={isPending}>
                  Generate codes
                </FormSubmitButton>
                {!target && (
                  <Button onPress={() => setCodes([])} isDisabled={isPending}>
                    Confirm received codes
                  </Button>
                )}
              </FormButtons>
            </Form>
          )}
        </Dialog>
      </Modal>
    </ControlledDialog>
  );
}
