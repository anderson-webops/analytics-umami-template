import { PERMISSIONS } from '@/lib/constants';
import type { ErrorStatus } from '@/lib/errors/schema';
import type { Auth } from '@/lib/types';
import {
  assertActorCanMutateEntity,
  assertCurrentActorAuth,
  runSerializable,
} from './authorization';
import { lockCollectionSources } from './collection';

export async function updateErrorIssue(
  websiteId: string,
  issueId: string,
  status: ErrorStatus,
  auth: Auth,
) {
  const actorUserId = auth.user?.id;
  if (!actorUserId) throw new Error('ENTITY_ACTOR_NOT_AUTHORIZED');
  return runSerializable(async transaction => {
    await assertCurrentActorAuth(transaction, actorUserId, auth);
    await lockCollectionSources(transaction, [websiteId]);
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'website',
      websiteId,
      PERMISSIONS.websiteUpdate,
    );
    const result = await transaction.errorIssue.updateMany({
      where: { id: issueId, websiteId },
      data: { status, resolvedAt: status === 'resolved' ? new Date() : null },
    });
    if (result.count !== 1) throw new Error('ERROR_ISSUE_NOT_FOUND');
    return result;
  });
}
