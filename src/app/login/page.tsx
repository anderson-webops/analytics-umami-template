import type { Metadata } from 'next';
import { isEnvEnabled } from '@/lib/env';
import { LoginPage } from './LoginPage';

export const dynamic = 'force-dynamic';

export default async function () {
  if (isEnvEnabled('DISABLE_LOGIN') || isEnvEnabled('CLOUD_MODE')) {
    return null;
  }

  return <LoginPage />;
}

export const metadata: Metadata = {
  title: 'Login',
};
