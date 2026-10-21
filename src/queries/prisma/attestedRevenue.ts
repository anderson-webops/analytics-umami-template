import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { BackendCollectionRequest } from '@/lib/collection-proof';
import { reserveCollectionSourceLimit } from '@/lib/collection-rate-limit';
import { reserveBackendCollectionRequest } from './collection';

export type AttestedRevenueMovementInput = {
  source: string;
  sourceMovementId: string;
  orderId: string;
  customerId: string | null;
  kind: 'capture';
  amount: string;
  currency: string;
  occurredAt: Date;
};

export class AttestedRevenueConflictError extends Error {
  constructor() {
    super('ATTESTED_REVENUE_MOVEMENT_CONFLICT');
  }
}

export async function recordAttestedRevenueMovement(
  transaction: Prisma.TransactionClient,
  websiteId: string,
  backendRequest: BackendCollectionRequest,
  movement: AttestedRevenueMovementInput,
) {
  if (movement.kind !== 'capture') {
    throw new AttestedRevenueConflictError();
  }

  const movementId = randomUUID();
  const amount = new Prisma.Decimal(movement.amount);
  const inserted = await transaction.attestedRevenueMovement.createMany({
    data: [
      {
        id: movementId,
        websiteId,
        source: movement.source,
        sourceMovementId: movement.sourceMovementId,
        orderId: movement.orderId,
        customerId: movement.customerId,
        kind: movement.kind,
        amount,
        currency: movement.currency,
        collectionGeneration: backendRequest.generation,
        occurredAt: movement.occurredAt,
      },
    ],
    skipDuplicates: true,
  });

  if (inserted.count === 0) {
    const existing = await transaction.attestedRevenueMovement.findUnique({
      where: {
        websiteId_sourceMovementId: { websiteId, sourceMovementId: movement.sourceMovementId },
      },
    });

    if (
      !existing ||
      existing.source !== movement.source ||
      existing.orderId !== movement.orderId ||
      existing.customerId !== movement.customerId ||
      existing.kind !== movement.kind ||
      !existing.amount.equals(amount) ||
      existing.currency !== movement.currency ||
      existing.collectionGeneration !== backendRequest.generation ||
      existing.occurredAt.getTime() !== movement.occurredAt.getTime()
    ) {
      throw new AttestedRevenueConflictError();
    }

    return { movementId: existing.id, duplicate: true };
  }

  await reserveBackendCollectionRequest(transaction, websiteId, backendRequest);
  await reserveCollectionSourceLimit(transaction, websiteId, 'backend');

  return { movementId, duplicate: false };
}
