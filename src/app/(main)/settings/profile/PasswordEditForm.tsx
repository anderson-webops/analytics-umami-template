import {
  Button,
  Column,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  PasswordField,
  Text,
  TextField,
} from '@umami/react-zen';
import { useState } from 'react';
import { useMessages, useUpdateQuery } from '@/components/hooks';

export function PasswordEditForm({ onSave, onClose }) {
  const { t, labels, messages, getErrorMessage } = useMessages();
  const { mutateAsync, error, isPending } = useUpdateQuery('/me/password');
  const recovery = useUpdateQuery('/auth/recovery-codes');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = isPending || recovery.isPending;

  const handleSubmit = async (data: any) => {
    if (!codes) {
      const prepared = await recovery
        .mutateAsync({ action: 'prepare', password: data.currentPassword })
        .catch(() => null);
      if (Array.isArray(prepared?.recoveryCodes) && prepared.recoveryCodes.length > 1) {
        setCodes(prepared.recoveryCodes);
        setSaved(false);
      }
      return;
    }

    if (!saved) return;
    await mutateAsync(
      {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        recoveryCode: data.recoveryCode,
        saved: true,
      },
      {
        onSuccess: async () => {
          onSave();
          onClose();
        },
      },
    ).catch(() => null);
  };

  const samePassword = (value: string, values: Record<string, any>) => {
    if (value !== values.newPassword) {
      return t(messages.noMatchPassword);
    }
    return true;
  };

  return (
    <Form
      onSubmit={handleSubmit}
      error={getErrorMessage(error || recovery.error)}
      className="rr-block"
    >
      <FormField
        label={t(labels.currentPassword)}
        name="currentPassword"
        rules={{ required: 'Required' }}
      >
        <PasswordField autoComplete="current-password" />
      </FormField>
      <FormField
        name="newPassword"
        label={t(labels.newPassword)}
        rules={{
          required: 'Required',
          minLength: { value: 8, message: t(messages.minPasswordLength, { n: '8' }) },
        }}
      >
        <PasswordField autoComplete="new-password" />
      </FormField>
      <FormField
        name="confirmPassword"
        label={t(labels.confirmPassword)}
        rules={{
          required: t(labels.required),
          minLength: { value: 8, message: t(messages.minPasswordLength, { n: '8' }) },
          validate: samePassword,
        }}
      >
        <PasswordField autoComplete="confirm-password" />
      </FormField>
      {codes && (
        <Column gap="4">
          <Text>Save these codes, then confirm one to change your password within 15 minutes.</Text>
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
          <FormField
            name="recoveryCode"
            label="Code from your saved copy"
            rules={{ required: t(labels.required) }}
          >
            <TextField autoComplete="off" spellCheck={false} />
          </FormField>
        </Column>
      )}
      <FormButtons>
        <Button onPress={onClose} isDisabled={pending}>
          {t(labels.cancel)}
        </Button>
        <FormSubmitButton isDisabled={pending || (codes !== null && !saved)}>
          {codes ? t(labels.save) : 'Prepare recovery codes'}
        </FormSubmitButton>
      </FormButtons>
    </Form>
  );
}
