'use client';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Code,
  Column,
  Dialog,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  Icon,
  Image,
  Modal,
  PasswordField,
  Row,
  Tag,
  TagGroup,
  Text,
} from '@umami/react-zen';
import { LucideCopy } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { ControlledDialog } from '@/components/common/ControlledDialog';
import { OtpInput } from '@/components/common/OtpInput';
import { useMessages, useUpdateQuery } from '@/components/hooks';
import styles from './TwoFactorSetupModal.module.css';
import { TwoFactorSuccessModal } from './TwoFactorSuccessModal';

function Step({
  tag,
  title,
  details,
  children,
}: {
  tag: string;
  title: string;
  details: string;
  children: ReactNode;
}) {
  return (
    <Column gap="5">
      <Column gap="3">
        <Row gap="3" alignItems="center">
          <TagGroup>
            <Tag variant="primary">{tag}</Tag>
          </TagGroup>
          <Text weight="bold">{title}</Text>
        </Row>
        <Text>{details}</Text>
      </Column>
      {children}
    </Column>
  );
}

interface TwoFactorSetupModalProps {
  required: boolean;
  onClose?: () => void;
}

export function TwoFactorSetupModal({ required, onClose }: TwoFactorSetupModalProps) {
  const { t, labels, messages, getErrorMessage } = useMessages();
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [manualKey, setManualKey] = useState<string | null>(null);
  const [otpValue, setOtpValue] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const passwordRef = useRef<string | null>(null);

  const queryClient = useQueryClient();
  const { mutateAsync: initiate, isPending: isInitiating } = useUpdateQuery('/2fa/setup/initiate');
  const { mutateAsync: confirm, isPending: isConfirming } = useUpdateQuery('/2fa/setup/confirm');
  const { mutate: cancel } = useUpdateQuery('/2fa/setup/cancel');

  const handleInitiate = async ({ password }: { password: string }) => {
    setError(null);
    try {
      const data: any = await initiate({ password });
      passwordRef.current = password;
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setManualKey(data.manualKey);
    } catch (err: any) {
      setError(getErrorMessage(err) || t(messages.error));
    }
  };

  const handleConfirm = async (value?: string) => {
    const token = value ?? otpValue;
    if (token.length !== 6) return;
    const password = passwordRef.current;
    if (!password) return;
    setError(null);
    try {
      const data: any = await confirm({ token, password });
      passwordRef.current = null;
      setBackupCodes(data.backupCodes);
    } catch (err: any) {
      setError(getErrorMessage(err) || t(messages.error));
    }
  };

  const handleCancel = async () => {
    passwordRef.current = null;
    cancel({});
    onClose?.();
  };

  const handleBack = () => {
    passwordRef.current = null;
    setQrCodeDataUrl(null);
    setManualKey(null);
    setOtpValue('');
    setError(null);
  };

  const handleCopy = () => {
    if (manualKey) {
      navigator.clipboard.writeText(manualKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (backupCodes) {
    return (
      <TwoFactorSuccessModal
        backupCodes={backupCodes}
        onClose={() => {
          queryClient.invalidateQueries({ queryKey: ['2fa-status'] });
          onClose?.();
        }}
      />
    );
  }

  const preventDismiss = required ? () => {} : undefined;

  return (
    <ControlledDialog>
      <Modal isOpen={true} onOpenChange={preventDismiss}>
        <Dialog
          title={t(labels.twoFactorSetupTitle)}
          className={`${styles.twoFactorSetupModal} rr-block`}
        >
          {() => (
            <Column gap="9">
              <Text>
                {required && `${t(messages.twoFactorSetupRequiredDescription)} `}
                {t(messages.twoFactorSetupDescription)}
              </Text>

              {!qrCodeDataUrl || !manualKey ? (
                <Form onSubmit={handleInitiate} error={error} defaultValues={{ password: '' }}>
                  <FormField
                    label={t(labels.currentPassword)}
                    name="password"
                    rules={{ required: t(labels.required) }}
                  >
                    <PasswordField
                      autoComplete="current-password"
                      onChange={() => setError(null)}
                    />
                  </FormField>
                  <FormButtons>
                    {!required && (
                      <Button variant="outline" onPress={handleCancel} isDisabled={isInitiating}>
                        {t(labels.cancel)}
                      </Button>
                    )}
                    <FormSubmitButton variant="primary" isDisabled={isInitiating}>
                      {t(labels.continue)}
                    </FormSubmitButton>
                  </FormButtons>
                </Form>
              ) : (
                <>
                  <Step
                    tag={t(labels.twoFactorStep1)}
                    title={t(labels.twoFactorScanQr)}
                    details={t(messages.twoFactorStep1Description)}
                  >
                    <Box padding="2" shadow="lg" borderRadius="lg" border width="fit">
                      <Row alignItems="center" gap="2">
                        {qrCodeDataUrl && (
                          <Image
                            src={qrCodeDataUrl}
                            alt="QR code"
                            className={styles.qrCodeImage}
                            borderRadius="lg"
                          />
                        )}
                        <Column>
                          <Text weight="bold">{t(labels.twoFactorCantScan)}</Text>
                          <Column gap="2">
                            <Text size="sm">{t(labels.twoFactorManualEntry)}</Text>
                            <Code>{manualKey}</Code>
                            <div>
                              <Button variant="outline" onPress={handleCopy}>
                                <Icon size="sm">
                                  <LucideCopy />
                                </Icon>
                                {copied
                                  ? t(labels.twoFactorCodeCopied)
                                  : t(labels.twoFactorCopyCode)}
                              </Button>
                            </div>
                          </Column>
                        </Column>
                      </Row>
                    </Box>
                  </Step>

                  {/* Step 2 - Enter Verification Code */}
                  <Step
                    tag={t(labels.twoFactorStep2)}
                    title={t(labels.twoFactorGetCode)}
                    details={t(messages.twoFactorStep2Description)}
                  >
                    <Column gap="3.5">
                      <Text size="sm" weight="bold">
                        {t(labels.twoFactorEnterCode)}
                      </Text>
                      <OtpInput
                        value={otpValue}
                        onChange={val => {
                          setOtpValue(val);
                          if (error) setError(null);
                        }}
                        onComplete={handleConfirm}
                        disabled={isConfirming}
                      />
                    </Column>
                  </Step>

                  {error && (
                    <Alert variant="danger">
                      <AlertTitle>{error}</AlertTitle>
                    </Alert>
                  )}

                  <Row gap="2" justifyContent="flex-end">
                    <Button variant="outline" onPress={handleBack} isDisabled={isConfirming}>
                      {t(labels.back)}
                    </Button>
                    {!required && (
                      <Button variant="outline" onPress={handleCancel} isDisabled={isConfirming}>
                        {t(labels.cancel)}
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      onPress={() => handleConfirm()}
                      isDisabled={otpValue.length !== 6 || isConfirming || !!error}
                    >
                      {t(labels.confirm)}
                    </Button>
                  </Row>
                </>
              )}
            </Column>
          )}
        </Dialog>
      </Modal>
    </ControlledDialog>
  );
}
