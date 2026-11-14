import type { Prisma } from '@/generated/prisma/client';
import { getTwoFactorRequirement } from './requirement';

export type TwoFactorRequiredReason = 'global' | 'user' | 'team';

export async function getTwoFactorRequiredReason(
  userId: string,
  transaction?: Prisma.TransactionClient,
): Promise<TwoFactorRequiredReason | null> {
  return (await getTwoFactorRequirement(userId, transaction)).reason;
}
