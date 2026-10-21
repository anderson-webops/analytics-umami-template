import {
  type CollectionAdmissionClass,
  CollectionBudgetExceededError,
} from '@/lib/collection-budget';
import { hash } from '@/lib/crypto';

export function getCollectionClientKeys(
  sourceType: string,
  sourceId: string,
  accountType: 'user' | 'team',
  accountId: string,
  clientIp: string,
  admissionClass: CollectionAdmissionClass = 'anonymous',
) {
  if (!clientIp) {
    throw new CollectionBudgetExceededError(60);
  }

  const clientKey = admissionClass === 'backend' ? `backend:${clientIp}` : clientIp;

  return {
    sourceClientHash: hash(`${sourceType}:${sourceId}:${clientKey}`).slice(0, 32),
    accountClientHash: hash(`${accountType}:${accountId}:${clientKey}`).slice(0, 32),
  };
}
