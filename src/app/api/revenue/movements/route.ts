import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import { CollectionRequestReplayError, getBackendCollectionRequest } from '@/lib/collection-proof';
import { getCollectionIpLimit } from '@/lib/collection-rate-limit';
import { isEnvEnabled } from '@/lib/env';
import { parseRequest } from '@/lib/request';
import { conflict, forbidden, serverError, tooManyRequests } from '@/lib/response';
import {
  AttestedRevenueConflictError,
  recordAttestedRevenueMovement,
  withActiveCollectionSource,
} from '@/queries/prisma';
import { attestedRevenueMovementSchema } from './schema';

function noStore(response: Response) {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: Request) {
  if (!isEnvEnabled('REVENUE_ATTESTED_INTAKE_ENABLED')) {
    return noStore(forbidden({ message: 'Attested revenue intake is not enabled.' }));
  }

  try {
    const limit = await getCollectionIpLimit(request);

    if (limit.blocked) {
      return noStore(tooManyRequests(limit.retryAfter));
    }

    const { body, error } = await parseRequest(request, attestedRevenueMovementSchema, {
      skipAuth: true,
      maxBodyBytes: 16 * 1024,
    });

    if (error) {
      return noStore(error());
    }

    const backendRequest = getBackendCollectionRequest(request, body.website, ['revenue']);

    if (!backendRequest) {
      return noStore(forbidden({ message: 'Backend collection authorization required.' }));
    }

    const result = await withActiveCollectionSource(
      'website',
      body.website,
      transaction =>
        recordAttestedRevenueMovement(transaction, body.website, backendRequest, {
          source: body.source,
          sourceMovementId: body.sourceMovementId,
          orderId: body.orderId,
          customerId: body.customerId,
          kind: body.kind,
          amount: body.amount,
          currency: body.currency,
          occurredAt: new Date(body.occurredAt),
        }),
      backendRequest,
    );

    return Response.json(
      {
        movementId: result.movementId,
        duplicate: result.duplicate,
        provenance: 'backend_attested',
      },
      { status: result.duplicate ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof AttestedRevenueConflictError) {
      return noStore(conflict({ message: 'Movement facts differ from the accepted record.' }));
    }
    if (error instanceof CollectionRequestReplayError) {
      return noStore(conflict({ message: 'Backend collection request already accepted.' }));
    }
    if (error instanceof CollectionBudgetExceededError) {
      return noStore(tooManyRequests(error.retryAfter));
    }
    if (
      error instanceof Error &&
      ['COLLECTION_SOURCE_NOT_FOUND', 'COLLECTION_KEY_OWNER_CHANGED'].includes(error.message)
    ) {
      return noStore(forbidden({ message: 'Backend collection authorization required.' }));
    }

    return noStore(serverError(error));
  }
}
