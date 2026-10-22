'use client';
import { Button } from '@umami/react-zen';
import { useState } from 'react';
import { useLoginQuery, useUser } from '@/components/hooks';
import { LoginRecoveryCodesModal } from '@/components/modals/LoginRecoveryCodesModal';

export function UserRecoverySettings({ userId }: { userId: string }) {
  const { user: actor } = useLoginQuery();
  const target = useUser();
  const [showCodes, setShowCodes] = useState(false);

  if (!actor?.isAdmin || actor.id === userId || !target?.username) {
    return null;
  }

  return (
    <>
      <Button variant="outline" onPress={() => setShowCodes(true)}>
        Issue recovery codes
      </Button>
      {showCodes && (
        <LoginRecoveryCodesModal
          target={{ id: userId, username: target.username }}
          onClose={() => setShowCodes(false)}
        />
      )}
    </>
  );
}
