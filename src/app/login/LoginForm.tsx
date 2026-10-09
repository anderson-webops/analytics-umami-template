import {
  Column,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  Heading,
  Icon,
  PasswordField,
  TextField,
} from '@umami/react-zen';
import { useRouter } from 'next/navigation';
import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';
import { useMessages, useUpdateQuery } from '@/components/hooks';
import { Logo } from '@/components/svg';
import { consumeReturnUrl } from '@/lib/return-url';
import { setUser } from '@/store/app';

type TurnstileClient = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

function getTurnstileClient(): TurnstileClient | undefined {
  return (window as Window & { turnstile?: TurnstileClient }).turnstile;
}

export function LoginForm({ captchaSiteKey }: { captchaSiteKey?: string }) {
  const { t, labels, getErrorMessage } = useMessages();
  const router = useRouter();
  const { mutateAsync, error } = useUpdateQuery('/auth/login');
  const loginError =
    error?.code === 'captcha-required' ||
    error?.message === 'Login verification is temporarily unavailable'
      ? error.message
      : getErrorMessage(error);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaError, setCaptchaError] = useState(false);
  const captchaContainer = useRef<HTMLDivElement>(null);
  const captchaWidgetId = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (captchaWidgetId.current) {
        getTurnstileClient()?.remove(captchaWidgetId.current);
        captchaWidgetId.current = null;
      }
    };
  }, []);

  const renderCaptcha = () => {
    const turnstile = getTurnstileClient();

    if (captchaSiteKey && turnstile && captchaContainer.current && !captchaWidgetId.current) {
      try {
        captchaWidgetId.current = turnstile.render(captchaContainer.current, {
          sitekey: captchaSiteKey,
          action: 'login',
          callback: token => {
            setCaptchaError(false);
            setCaptchaToken(token);
          },
          'expired-callback': () => setCaptchaToken(''),
          'error-callback': () => {
            setCaptchaToken('');
            setCaptchaError(true);
          },
        });
      } catch {
        setCaptchaError(true);
      }
    }
  };

  const handleSubmit = async (data: any) => {
    if (captchaSiteKey && !captchaToken) return;

    try {
      await mutateAsync(
        { ...data, ...(captchaSiteKey ? { captchaToken } : {}) },
        {
          onSuccess: async (response: any) => {
            if (response.requiresTwoFactor) {
              sessionStorage.setItem('umami.partial-token', response.partialToken);
              router.push('/login/two-factor');
              return;
            }
            setUser(response.user);
            router.push(consumeReturnUrl() ?? '/');
          },
        },
      );
    } finally {
      if (captchaSiteKey) {
        setCaptchaToken('');
        if (captchaWidgetId.current) {
          getTurnstileClient()?.reset(captchaWidgetId.current);
        }
      }
    }
  };

  return (
    <Column justifyContent="center" alignItems="center" gap="6">
      <Icon size="lg">
        <Logo />
      </Icon>
      <Heading>umami</Heading>
      <Form
        onSubmit={handleSubmit}
        error={loginError}
        defaultValues={{ username: '', password: '' }}
        style={{ minWidth: 300 }}
      >
        <FormField
          label={t(labels.username)}
          data-test="input-username"
          name="username"
          rules={{ required: t(labels.required) }}
        >
          <TextField autoComplete="username" />
        </FormField>

        <FormField
          label={t(labels.password)}
          data-test="input-password"
          name="password"
          rules={{ required: t(labels.required) }}
        >
          <PasswordField autoComplete="current-password" />
        </FormField>
        {captchaSiteKey && (
          <>
            <Script
              src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
              strategy="afterInteractive"
              onReady={renderCaptcha}
              onError={() => setCaptchaError(true)}
            />
            <div ref={captchaContainer} data-test="login-captcha" />
            {captchaError && (
              <span role="alert">Login verification is unavailable. Refresh and try again.</span>
            )}
          </>
        )}
        <FormButtons>
          <FormSubmitButton
            data-test="button-submit"
            variant="primary"
            style={{ flex: 1 }}
            isDisabled={Boolean(captchaSiteKey && !captchaToken)}
          >
            {t(labels.login)}
          </FormSubmitButton>
        </FormButtons>
      </Form>
    </Column>
  );
}
