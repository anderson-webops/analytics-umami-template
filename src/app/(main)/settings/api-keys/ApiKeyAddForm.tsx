import {
  Alert,
  AlertTitle,
  Button,
  Column,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  Icon,
  PasswordField,
  Row,
  Text,
  TextField,
} from '@umami/react-zen';
import { useState } from 'react';
import { CopyButton } from '@/components/common/CopyButton';
import { OtpInput } from '@/components/common/OtpInput';
import { useMessages, useTwoFactorStatusQuery, useUpdateQuery } from '@/components/hooks';
import { AlertTriangle } from '@/components/icons';

export function ApiKeyAddForm({ onSave, onClose }: { onSave: () => void; onClose: () => void }) {
  const { t, labels, messages, getErrorMessage } = useMessages();
  const { mutateAsync, error, isPending } = useUpdateQuery('/me/api-keys');
  const {
    data: twoFactorStatus,
    isLoading: isTwoFactorLoading,
    isError: isTwoFactorError,
  } = useTwoFactorStatusQuery(true);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [token, setToken] = useState('');

  const handleSubmit = async (data: any) => {
    await mutateAsync(
      { ...data, ...(twoFactorStatus?.isEnabled ? { token } : {}) },
      {
        onSuccess: async result => {
          setCreatedKey(result.key);
          onSave?.();
        },
      },
    );
  };

  if (createdKey) {
    return (
      <Column gap="4">
        <Alert>
          <Icon>
            <AlertTriangle />
          </Icon>
          <AlertTitle>{t(messages.apiKeyCreated)}</AlertTitle>
        </Alert>
        <Row alignItems="center" gap="2">
          <TextField value={createdKey} isReadOnly style={{ flex: 1, fontFamily: 'monospace' }} />
          <CopyButton value={createdKey} label={t(labels.copy)} />
        </Row>
        <Row justifyContent="flex-end">
          <Button variant="primary" onPress={onClose}>
            {t(labels.close)}
          </Button>
        </Row>
      </Column>
    );
  }

  return (
    <Form onSubmit={handleSubmit} error={getErrorMessage(error)}>
      <FormField name="name" label={t(labels.name)}>
        <TextField autoComplete="off" autoFocus />
      </FormField>
      <FormField
        name="currentPassword"
        label={t(labels.currentPassword)}
        rules={{ required: t(labels.required) }}
      >
        <PasswordField autoComplete="current-password" />
      </FormField>
      {twoFactorStatus?.isEnabled && (
        <Column gap="1">
          <Text size="sm">{t(labels.twoFactorEnterCode)}</Text>
          <OtpInput value={token} onChange={setToken} disabled={isPending} />
        </Column>
      )}
      <FormButtons>
        <Button isDisabled={isPending} onPress={onClose}>
          {t(labels.cancel)}
        </Button>
        <FormSubmitButton
          variant="primary"
          isDisabled={
            isPending ||
            isTwoFactorLoading ||
            isTwoFactorError ||
            !twoFactorStatus ||
            (twoFactorStatus.isEnabled && token.length !== 6)
          }
        >
          {t(labels.save)}
        </FormSubmitButton>
      </FormButtons>
    </Form>
  );
}
