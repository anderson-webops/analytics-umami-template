'use client';
import { Column, Dialog, Modal, type ModalProps } from '@umami/react-zen';
import { SessionProfile } from '@/app/(main)/websites/[websiteId]/sessions/SessionProfile';
import { ControlledDialog } from '@/components/common/ControlledDialog';
import { useMessages, useMobile, useNavigation, useShare } from '@/components/hooks';
import { canViewShareSection } from '@/lib/share';
import styles from './SessionModal.module.css';

export interface SessionModalProps extends ModalProps {
  websiteId: string;
}

export function SessionModal({ websiteId, className, ...props }: SessionModalProps) {
  const {
    router,
    pathname,
    query: { session },
    updateParams,
  } = useNavigation();
  const { isMobile } = useMobile();
  const { t, labels } = useMessages();
  const share = useShare();
  const isSharePage = pathname.includes('/share/');
  const canOpenSession = canViewShareSection(share?.parameters, 'sessions');
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      router.replace(updateParams({ session: undefined }), { scroll: false });
    }
  };

  return (
    <ControlledDialog>
      <Modal
        className={[styles.modal, className].filter(Boolean).join(' ')}
        onOpenChange={handleOpenChange}
        {...props}
        isOpen={!!session && canOpenSession}
      >
        <Column height="100%">
          <Dialog aria-label={t(labels.session)} className="h-full rounded-lg">
            {({ close }) => (
              <Column
                paddingX={isMobile ? '6' : '10'}
                paddingTop="6"
                paddingBottom={isMobile ? '6' : '10'}
                minWidth="0"
                width="100%"
              >
                <SessionProfile
                  websiteId={websiteId}
                  sessionId={session}
                  showReplays={!isSharePage}
                  onClose={() => close()}
                />
              </Column>
            )}
          </Dialog>
        </Column>
      </Modal>
    </ControlledDialog>
  );
}
