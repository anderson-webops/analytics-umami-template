import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import { hash } from '@/lib/crypto';

export function getCollectionClientKeys(
  sourceType: string,
  sourceId: string,
  accountType: 'user' | 'team',
  accountId: string,
  clientIp: string,
) {
  if (!clientIp) {
    throw new CollectionBudgetExceededError(60);
  }

  return {
    sourceClientHash: hash(`${sourceType}:${sourceId}:${clientIp}`).slice(0, 32),
    accountClientHash: hash(`${accountType}:${accountId}:${clientIp}`).slice(0, 32),
  };
}
