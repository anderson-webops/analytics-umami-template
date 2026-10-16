import type { Prisma } from '@/generated/prisma/client';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '@/lib/constants';
import { hash } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import type { Auth } from '@/lib/types';
import { hasMutableGlobalRole } from '@/permissions/mutation';

export type OwnedEntityType = 'website' | 'link' | 'pixel' | 'board';
export type EntityMutationPermission =
  | typeof PERMISSIONS.websiteUpdate
  | typeof PERMISSIONS.websiteDelete;

type OwnedEntity = {
  id: string;
  userId: string | null;
  teamId: string | null;
};

type EntityReference = {
  entityType: OwnedEntityType;
  entityId: string;
};

export const SERIALIZABLE_RETRY_ATTEMPTS = 8;
const SERIALIZABLE_RETRY_BASE_DELAY_MS = 50;
const SERIALIZABLE_RETRY_MAX_DELAY_MS = 1_000;
const USER_MUTATION_LOCK_KEY = 'umami:user-mutations';

function hasSerializableConflictMarker(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const meta = 'meta' in error ? error.meta : null;
  const adapterError =
    meta && typeof meta === 'object' && 'driverAdapterError' in meta
      ? meta.driverAdapterError
      : null;

  if (
    'code' in error &&
    error.code === 'P2010' &&
    adapterError &&
    typeof adapterError === 'object' &&
    'cause' in adapterError &&
    hasSerializableConflictMarker(adapterError.cause)
  ) {
    return true;
  }

  return (
    ('code' in error && (error.code === 'P2034' || error.code === '40001')) ||
    ('originalCode' in error && error.originalCode === '40001') ||
    ('kind' in error && error.kind === 'TransactionWriteConflict')
  );
}

export function isSerializableRetryError(error: unknown): boolean {
  if (hasSerializableConflictMarker(error)) {
    return true;
  }

  return (
    typeof error === 'object' &&
    error !== null &&
    'cause' in error &&
    hasSerializableConflictMarker(error.cause)
  );
}

export async function waitForSerializableRetry(attempt: number): Promise<void> {
  const exponentialDelay = Math.min(
    SERIALIZABLE_RETRY_BASE_DELAY_MS * 2 ** attempt,
    SERIALIZABLE_RETRY_MAX_DELAY_MS,
  );
  const jitter = Math.floor(Math.random() * SERIALIZABLE_RETRY_BASE_DELAY_MS);

  await new Promise(resolve => setTimeout(resolve, exponentialDelay + jitter));
}

export async function runSerializedUserMutation<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number } = {},
): Promise<T> {
  return runSerializable(
    async transaction => {
      await lockUserMutation(transaction);
      return operation(transaction);
    },
    {
      timeout: 30_000,
      ...options,
    },
  );
}

async function lockUserMutation(transaction: Prisma.TransactionClient) {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${USER_MUTATION_LOCK_KEY}))::text
  `;
}

export async function runCredentialRevocationMutation<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.transaction(
    async transaction => {
      await lockUserMutation(transaction);
      return operation(transaction);
    },
    { isolationLevel: 'ReadCommitted', timeout: 30_000 },
  );
}

export class SessionRevokedError extends Error {}

export async function runActiveSessionMutation<T>(
  auth: Auth,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const sessionGeneration = auth.sessionGeneration;
  if (
    auth.authType !== 'session' ||
    !auth.user?.id ||
    typeof sessionGeneration !== 'number' ||
    !Number.isSafeInteger(sessionGeneration) ||
    sessionGeneration < 0 ||
    !auth.passwordFingerprint
  ) {
    throw new SessionRevokedError();
  }

  return runCredentialRevocationMutation(async transaction => {
    const current = await transaction.$queryRaw<
      Array<{ password: string; role: string; sessionGeneration: number }>
    >`
      SELECT password, role, session_generation AS "sessionGeneration"
      FROM "user"
      WHERE user_id = ${auth.user.id}::uuid
        AND deleted_at IS NULL
      FOR UPDATE
    `;

    if (
      current.length !== 1 ||
      current[0].role !== auth.user.role ||
      current[0].sessionGeneration !== sessionGeneration ||
      hash(current[0].password) !== auth.passwordFingerprint
    ) {
      throw new SessionRevokedError();
    }

    if (redis.enabled && auth.authKey) {
      const session = await redis.client.get(auth.authKey);
      if (
        session?.userId !== auth.user.id ||
        session.role !== auth.user.role ||
        session.pwd !== auth.passwordFingerprint ||
        session.sessionGeneration !== sessionGeneration
      ) {
        throw new SessionRevokedError();
      }
    }

    return operation(transaction);
  });
}

function roleHasPermission(role: string | null | undefined, permission: string) {
  if (!role) {
    return false;
  }

  const permissions = ROLE_PERMISSIONS[role] as readonly string[] | undefined;

  return !!permissions?.some(value => value === PERMISSIONS.all || value === permission);
}

export async function runSerializable<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number } = {},
): Promise<T> {
  for (let attempt = 0; attempt < SERIALIZABLE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.transaction(operation, {
        isolationLevel: 'Serializable',
        ...options,
      });
    } catch (error) {
      if (!isSerializableRetryError(error) || attempt === SERIALIZABLE_RETRY_ATTEMPTS - 1) {
        throw error;
      }

      await waitForSerializableRetry(attempt);
    }
  }

  throw new Error('AUTHORIZATION_RETRY_EXHAUSTED');
}

export async function lockActorRoleForMutation(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  notAuthorizedError = 'ENTITY_ACTOR_NOT_AUTHORIZED',
) {
  const actors = await transaction.$queryRaw<
    Array<{ user_id: string; enrollmentRequired: boolean; enrolled: boolean }>
  >`
    SELECT u.user_id,
      (
        u.two_factor_required
        OR COALESCE(
          (SELECT value = 'true' FROM app_setting WHERE key = 'twoFactorRequiredGlobal'),
          false
        )
        OR EXISTS (
          SELECT 1 FROM team_user tu
          JOIN team t ON t.team_id = tu.team_id
          WHERE tu.user_id = u.user_id AND t.two_factor_required
        )
      ) AS "enrollmentRequired",
      EXISTS (
        SELECT 1 FROM two_factor_auth factor
        WHERE factor.user_id = u.user_id AND factor.is_enabled
      ) AS enrolled
    FROM "user" u
    WHERE u.user_id = ${actorUserId}::uuid
    FOR NO KEY UPDATE OF u
  `;

  if (!isEnvEnabled('CLOUD_MODE') && actors[0]?.enrollmentRequired && !actors[0].enrolled) {
    throw new Error(notAuthorizedError);
  }
}

export async function assertCurrentMutationAuth(
  transaction: Prisma.TransactionClient,
  auth: Auth,
  notAuthorizedError = 'ENTITY_ACTOR_NOT_AUTHORIZED',
) {
  const actorUserId = auth.user?.id;

  if (!actorUserId || (auth.authType !== 'session' && auth.authType !== 'api-key')) {
    throw new Error(notAuthorizedError);
  }

  await lockActorRoleForMutation(transaction, actorUserId, notAuthorizedError);
  const actor = await transaction.user.findUnique({
    where: { id: actorUserId },
    select: { role: true, password: true, sessionGeneration: true, deletedAt: true },
  });

  if (!actor || actor.deletedAt || actor.role !== auth.user.role) {
    throw new Error(notAuthorizedError);
  }

  if (auth.authType === 'api-key') {
    const key = auth.apiKey?.id
      ? await transaction.apiKey.findUnique({
          where: { id: auth.apiKey.id },
          select: { userId: true, expiresAt: true },
        })
      : null;

    if (!key || key.userId !== actorUserId || key.expiresAt.getTime() <= Date.now()) {
      throw new Error(notAuthorizedError);
    }

    return;
  }

  if (
    typeof auth.sessionGeneration !== 'number' ||
    !Number.isSafeInteger(auth.sessionGeneration) ||
    auth.sessionGeneration < 0 ||
    actor.sessionGeneration !== auth.sessionGeneration ||
    !auth.passwordFingerprint ||
    hash(actor.password) !== auth.passwordFingerprint
  ) {
    throw new Error(notAuthorizedError);
  }

  if (!isEnvEnabled('CLOUD_MODE')) {
    const factor = await transaction.twoFactorAuth.findUnique({
      where: { userId: actorUserId },
      select: { id: true, isEnabled: true },
    });

    if (factor?.isEnabled && (!auth.mfaVerified || auth.mfaId !== factor.id)) {
      throw new Error(notAuthorizedError);
    }
  }

  if (redis.enabled && auth.authKey) {
    const session = await redis.client.get(auth.authKey);

    if (
      session?.userId !== actorUserId ||
      session.role !== auth.user.role ||
      session.pwd !== auth.passwordFingerprint ||
      session.sessionGeneration !== auth.sessionGeneration ||
      (!isEnvEnabled('CLOUD_MODE') &&
        auth.mfaVerified &&
        (session.mfa !== true || session.mfaId !== auth.mfaId))
    ) {
      throw new Error(notAuthorizedError);
    }
  }
}

export async function assertCurrentActorAuth(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  auth: Auth,
  notAuthorizedError = 'ENTITY_ACTOR_NOT_AUTHORIZED',
) {
  if (auth.user?.id !== actorUserId) {
    throw new Error(notAuthorizedError);
  }

  await assertCurrentMutationAuth(transaction, auth, notAuthorizedError);
}

export async function lockActorTeamMembershipForMutation(
  transaction: Prisma.TransactionClient,
  teamId: string,
  actorUserId: string,
) {
  await transaction.$queryRaw`
    SELECT team_user_id
    FROM team_user
    WHERE team_id = ${teamId}::uuid
      AND user_id = ${actorUserId}::uuid
    FOR NO KEY UPDATE
  `;
}

export async function getOwnedEntityForUpdate(
  transaction: Prisma.TransactionClient,
  entityType: OwnedEntityType,
  entityId: string,
): Promise<OwnedEntity | null> {
  const select = {
    id: true,
    userId: true,
    teamId: true,
  } as const;

  switch (entityType) {
    case 'website':
      return transaction.website.findFirst({
        where: { id: entityId, deletedAt: null },
        select,
      });
    case 'link':
      return transaction.link.findFirst({
        where: { id: entityId, deletedAt: null },
        select,
      });
    case 'pixel':
      return transaction.pixel.findFirst({
        where: { id: entityId, deletedAt: null },
        select,
      });
    case 'board':
      return transaction.board.findUnique({
        where: { id: entityId },
        select,
      });
  }
}

export async function assertActorCanMutateEntity(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  entityType: OwnedEntityType,
  entityId: string,
  permission: EntityMutationPermission,
) {
  await lockActorRoleForMutation(transaction, actorUserId);
  const actor = await transaction.user.findFirst({
    where: {
      id: actorUserId,
      deletedAt: null,
    },
    select: {
      role: true,
    },
  });
  const entity = await getOwnedEntityForUpdate(transaction, entityType, entityId);

  if (!entity) {
    throw new Error('ENTITY_NOT_FOUND');
  }

  if (!actor || !hasMutableGlobalRole(actor.role)) {
    throw new Error('ENTITY_ACTOR_NOT_AUTHORIZED');
  }

  if (actor.role === ROLES.admin || entity.userId === actorUserId) {
    return entity;
  }

  if (entity.teamId) {
    await lockActorTeamMembershipForMutation(transaction, entity.teamId, actorUserId);
    const membership = await transaction.teamUser.findFirst({
      where: {
        teamId: entity.teamId,
        userId: actorUserId,
        team: { deletedAt: null },
        user: { deletedAt: null },
      },
      select: {
        role: true,
      },
    });

    if (roleHasPermission(membership?.role, permission)) {
      return entity;
    }
  }

  throw new Error('ENTITY_ACTOR_NOT_AUTHORIZED');
}

export async function assertActorCanAccessEntities(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  references: EntityReference[],
  permission?: EntityMutationPermission,
) {
  if (references.length === 0) {
    return;
  }

  await lockActorRoleForMutation(transaction, actorUserId, 'ENTITY_REFERENCE_NOT_AUTHORIZED');
  const actor = await transaction.user.findFirst({
    where: {
      id: actorUserId,
      deletedAt: null,
    },
    select: {
      role: true,
    },
  });
  const entities = [];

  for (const reference of references) {
    entities.push(
      await getOwnedEntityForUpdate(transaction, reference.entityType, reference.entityId),
    );
  }

  if (!actor || !hasMutableGlobalRole(actor.role) || entities.some(entity => !entity)) {
    throw new Error('ENTITY_REFERENCE_NOT_AUTHORIZED');
  }

  if (actor.role === ROLES.admin) {
    return;
  }

  const teamIds = [
    ...new Set(
      entities.map(entity => entity?.teamId).filter((teamId): teamId is string => !!teamId),
    ),
  ].sort();
  for (const teamId of teamIds) {
    await lockActorTeamMembershipForMutation(transaction, teamId, actorUserId);
  }
  const memberships = teamIds.length
    ? await transaction.teamUser.findMany({
        where: {
          teamId: { in: teamIds },
          userId: actorUserId,
          team: { deletedAt: null },
          user: { deletedAt: null },
        },
        select: {
          teamId: true,
          role: true,
        },
      })
    : [];
  const membershipByTeamId = new Map(
    memberships.map(membership => [membership.teamId, membership.role]),
  );

  const canAccessAll = entities.every(entity => {
    if (!entity) {
      return false;
    }

    if (entity.userId === actorUserId) {
      return true;
    }

    if (!entity.teamId) {
      return false;
    }

    const role = membershipByTeamId.get(entity.teamId);

    return permission ? roleHasPermission(role, permission) : !!role;
  });

  if (!canAccessAll) {
    throw new Error('ENTITY_REFERENCE_NOT_AUTHORIZED');
  }
}

export async function assertActorCanCreateOwnedEntity(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  owner: { userId: string; teamId?: never } | { teamId: string; userId?: never },
  options: { auth: Auth; requireGlobalCreatePermission?: boolean },
) {
  const { requireGlobalCreatePermission = true, auth } = options;
  await assertCurrentActorAuth(transaction, actorUserId, auth);
  const actor = await transaction.user.findFirst({
    where: {
      id: actorUserId,
      deletedAt: null,
    },
    select: {
      role: true,
    },
  });

  if (
    !actor ||
    !hasMutableGlobalRole(actor.role) ||
    (requireGlobalCreatePermission && !roleHasPermission(actor.role, PERMISSIONS.websiteCreate))
  ) {
    throw new Error('ENTITY_ACTOR_NOT_AUTHORIZED');
  }

  if ('userId' in owner) {
    if (owner.userId !== actorUserId && actor.role !== ROLES.admin) {
      throw new Error('ENTITY_ACTOR_NOT_AUTHORIZED');
    }

    const destinationUser = await transaction.user.findFirst({
      where: {
        id: owner.userId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!destinationUser) {
      throw new Error('ENTITY_OWNER_NOT_FOUND');
    }

    return;
  }

  const team = await transaction.team.findFirst({
    where: {
      id: owner.teamId,
      deletedAt: null,
    },
    select: {
      id: true,
    },
  });
  await lockActorTeamMembershipForMutation(transaction, owner.teamId, actorUserId);
  const membership = await transaction.teamUser.findFirst({
    where: {
      teamId: owner.teamId,
      userId: actorUserId,
      team: { deletedAt: null },
      user: { deletedAt: null },
    },
    select: {
      role: true,
    },
  });

  if (!team) {
    throw new Error('ENTITY_OWNER_NOT_FOUND');
  }

  if (
    actor.role !== ROLES.admin &&
    !roleHasPermission(membership?.role, PERMISSIONS.websiteCreate)
  ) {
    throw new Error('ENTITY_ACTOR_NOT_AUTHORIZED');
  }
}

export async function assertActorIsAdministrator(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
) {
  if (!actorUserId) {
    throw new Error('ENTITY_ADMIN_REQUIRED');
  }

  await lockActorRoleForMutation(transaction, actorUserId, 'ENTITY_ADMIN_REQUIRED');

  const actor = await transaction.$queryRaw<Array<{ allowed: number }>>`
    SELECT 1 AS allowed FROM "user"
    WHERE user_id = ${actorUserId}::uuid
      AND role = ${ROLES.admin}
      AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `;

  if (actor.length !== 1) {
    throw new Error('ENTITY_ADMIN_REQUIRED');
  }
}

export async function runAuthorizedAdministratorMutation<T>(
  actorUserId: string,
  auth: Auth,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return runSerializedUserMutation(async transaction => {
    await assertCurrentActorAuth(transaction, actorUserId, auth, 'ENTITY_ADMIN_REQUIRED');
    await assertActorIsAdministrator(transaction, actorUserId);
    return operation(transaction);
  });
}

export async function assertEntityIdAvailable(
  transaction: Prisma.TransactionClient,
  entityId: string,
) {
  const entities = [
    await transaction.website.findUnique({ where: { id: entityId }, select: { id: true } }),
    await transaction.link.findUnique({ where: { id: entityId }, select: { id: true } }),
    await transaction.pixel.findUnique({ where: { id: entityId }, select: { id: true } }),
    await transaction.board.findUnique({ where: { id: entityId }, select: { id: true } }),
  ];

  if (entities.some(Boolean)) {
    throw new Error('ENTITY_ID_CONFLICT');
  }
}
