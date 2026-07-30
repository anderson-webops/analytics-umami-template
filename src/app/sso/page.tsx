import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { isEnvEnabled } from '@/lib/env';
import { SSOPage } from './SSOPage';

export default function () {
  if (!isEnvEnabled('CLOUD_MODE')) {
    notFound();
  }

  return (
    <Suspense>
      <SSOPage />
    </Suspense>
  );
}
