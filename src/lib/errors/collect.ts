import type { Prisma } from '@/generated/prisma/client';
import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import type { ErrorPayload } from '@/lib/errors/schema';
import { consumeErrorQuota, saveError } from '@/queries/sql/errors/store';

export async function collectError(
  payload: ErrorPayload,
  context: { sessionId: string; visitId: string; browser?: string; os?: string; device?: string },
  transaction: Prisma.TransactionClient,
) {
  if (!(await consumeErrorQuota(payload.website, transaction))) {
    throw new CollectionBudgetExceededError(60);
  }

  return saveError(payload, context, transaction);
}
