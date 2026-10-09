'use client';
import { Button, Column, Heading } from '@umami/react-zen';
import { useMessages } from '@/components/hooks';
import { useLogout } from '@/components/hooks/useLogout';

export function LogoutPage() {
  const { t, labels } = useMessages();
  const logout = useLogout();

  return (
    <main>
      <Column
        alignItems="center"
        justifyContent="center"
        height="100vh"
        backgroundColor="surface-raised"
        gap="6"
      >
        <Heading>{t(labels.logout)}</Heading>
        <Button variant="primary" onPress={logout}>
          {t(labels.logout)}
        </Button>
      </Column>
    </main>
  );
}
