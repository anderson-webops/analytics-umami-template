import type { Prisma } from '@/generated/prisma/client';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '@/lib/constants';
import prisma from '@/lib/prisma';

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
  return prisma.transaction(
    async transaction => {
      // Account mutations share cross-row invariants such as the final active
      // administrator. Queue them before re-reading authorization state so
      // concurrent requests cannot race those checks.
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${USER_MUTATION_LOCK_KEY}))::text
      `;

      return operation(transaction);
    },
    {
      isolationLevel: 'ReadCommitted',
      timeout: 30_000,
      ...options,
    },
  );
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

  if (!actor) {
    throw new Error('ENTITY_ACTOR_NOT_AUTHORIZED');
  }

  if (actor.role === ROLES.admin || entity.userId === actorUserId) {
    return entity;
  }

  if (entity.teamId) {
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

  if (!actor || entities.some(entity => !entity)) {
    throw new Error('ENTITY_REFERENCE_NOT_AUTHORIZED');
  }

  if (actor.role === ROLES.admin) {
    return;
  }

  const teamIds = [
    ...new Set(
      entities.map(entity => entity?.teamId).filter((teamId): teamId is string => !!teamId),
    ),
  ];
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
  options: { requireGlobalCreatePermission?: boolean } = {},
) {
  const { requireGlobalCreatePermission = true } = options;
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
  const actor = await transaction.user.findFirst({
    where: {
      id: actorUserId,
      role: ROLES.admin,
      deletedAt: null,
    },
    select: {
      id: true,
    },
  });

  if (!actor) {
    throw new Error('ENTITY_ADMIN_REQUIRED');
  }
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
