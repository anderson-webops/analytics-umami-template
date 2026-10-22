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
} from '@umami/react-zen';
import { useState } from 'react';
import { ControlledDialog } from '@/components/common/ControlledDialog';
import { useMessages, useUpdateQuery } from '@/components/hooks';

export function LoginRecoveryCodesModal({
  onClose,
  onRotated,
}: {
  onClose: () => void;
  onRotated: () => void;
}) {
  const { t, labels, getErrorMessage } = useMessages();
  const { mutateAsync, error, isPending } = useUpdateQuery('/auth/recovery-codes');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async ({ password }: { password: string }) => {
    const response = await mutateAsync({ password }).catch(() => null);
    if (!response) return;
    setCodes(response.recoveryCodes);
    onRotated();
  };

  return (
    <ControlledDialog>
      <Modal isOpen={true} onOpenChange={codes ? () => {} : onClose}>
        <Dialog title="Login recovery codes" className="rr-block" style={{ maxWidth: '95vw' }}>
          {codes ? (
            <Column gap="4">
              <Text>
                Save these now. Each login attempt spends one code; they will not be shown again.
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
                I saved these codes
              </label>
              <FormButtons>
                <Button variant="primary" onPress={onClose} isDisabled={!saved}>
                  {t(labels.close)}
                </Button>
              </FormButtons>
            </Column>
          ) : (
            <Form
              onSubmit={handleSubmit}
              error={getErrorMessage(error)}
              defaultValues={{ password: '' }}
            >
              <Text>New codes replace any previous login recovery codes.</Text>
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
              </FormButtons>
            </Form>
          )}
        </Dialog>
      </Modal>
    </ControlledDialog>
  );
}
