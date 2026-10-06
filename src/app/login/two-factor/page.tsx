import type { Metadata } from 'next';
import { LoginPageWrapper } from '@/app/login/LoginPage';
import { isEnvEnabled } from '@/lib/env';
import { LoginTwoFactorPage } from './LoginTwoFactorPage';

export default async function () {
  if (isEnvEnabled('DISABLE_LOGIN') || isEnvEnabled('CLOUD_MODE')) {
    return null;
  }

  return (
    <LoginPageWrapper>
      <LoginTwoFactorPage />
    </LoginPageWrapper>
  );
}

export const metadata: Metadata = {
  title: 'Two-factor authentication',
};
