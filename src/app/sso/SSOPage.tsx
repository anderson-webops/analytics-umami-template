'use client';
import { Loading } from '@umami/react-zen';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { getApiUrl } from '@/lib/api-url';
import { getSafeNavigationTarget } from '@/lib/security';

export function SSOPage() {
  const router = useRouter();
  const search = useSearchParams();
  const url = search.get('url');
  const token = search.get('token');

  useEffect(() => {
    if (url && token) {
      window.history.replaceState(null, '', window.location.pathname);
      const target = getSafeNavigationTarget(url);

      if (!target || target.external) {
        router.replace('/');
        return;
      }

      void fetch(getApiUrl('/auth/sso'), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }).then(response => {
        router.replace(response.ok ? target.url : '/login');
      });
    }
  }, [router, url, token]);

  return <Loading placement="absolute" />;
}
