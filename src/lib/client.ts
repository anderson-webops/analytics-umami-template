import { removeItem } from '@/lib/storage';
import { AUTH_TOKEN } from './constants';

export function removeClientAuthToken() {
  removeItem(AUTH_TOKEN);
}
