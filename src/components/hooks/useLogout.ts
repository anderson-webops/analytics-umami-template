import { useToast } from '@umami/react-zen';
import { removeClientAuthToken } from '@/lib/client';
import { setUser } from '@/store/app';
import { useApi } from './useApi';
import { useMessages } from './useMessages';

export function useLogout() {
  const { post } = useApi();
  const { t, messages } = useMessages();
  const { toast } = useToast();

  return async () => {
    try {
      await post('/auth/logout');
    } catch (error) {
      if ((error as { status?: number }).status !== 401) {
        toast(t(messages.error));
        return;
      }
    }

    removeClientAuthToken();
    setUser(null);
    window.location.href = `${process.env.basePath || ''}/login`;
  };
}
