import type { Metadata } from 'next';
import { isEnvEnabled } from '@/lib/env';
import { LogoutPage } from './LogoutPage';

export const dynamic = 'force-dynamic';

export default function () {
  if (isEnvEnabled('DISABLE_LOGIN') || isEnvEnabled('CLOUD_MODE')) {
    return null;
  }

  return <LogoutPage />;
}

export const metadata: Metadata = {
  title: 'Logout',
};
