import { Prisma } from '@/generated/prisma/client';
import { PERMISSIONS, ROLES } from '@/lib/constants';
import { isUuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { assertActorCanMutateEntity, runSerializable } from './authorization';

import ReportFindManyArgs = Prisma.ReportFindManyArgs;

async function findReport(criteria: Prisma.ReportFindUniqueArgs) {
  return prisma.client.report.findUnique(criteria);
}

export async function getReport(reportId: string) {
  if (!isUuid(reportId)) {
    return null;
  }

  return findReport({
    where: {
      id: reportId,
    },
  });
}

export async function getReports(criteria: ReportFindManyArgs, filters: QueryFilters = {}) {
  const { search } = filters;
  const orderBy = criteria.orderBy ?? [{ name: 'asc' }, { id: 'asc' }];

  const where: Prisma.ReportWhereInput = {
    ...criteria.where,
    ...prisma.getSearchParameters(search, [
      { name: 'contains' },
      { description: 'contains' },
      { type: 'contains' },
      {
        user: {
          username: 'contains',
        },
      },
      {
        website: {
          name: 'contains',
        },
      },
      {
        website: {
          domain: 'contains',
        },
      },
    ]),
  };

  return prisma.pagedQuery('report', { ...criteria, where, orderBy }, filters);
}

export async function getUserReports(userId: string, filters?: QueryFilters) {
  return getReports(
    {
      where: {
        userId,
      },
      include: {
        website: {
          select: {
            domain: true,
            userId: true,
          },
        },
      },
    },
    filters,
  );
}

export async function getWebsiteReports(websiteId: string, filters: QueryFilters = {}) {
  return getReports(
    {
      where: {
        websiteId,
      },
    },
    filters,
  );
}

export async function createReport(data: Prisma.ReportUncheckedCreateInput, actorUserId: string) {
  return runSerializable(async transaction => {
    if (data.userId !== actorUserId) {
      throw new Error('REPORT_ACTOR_NOT_AUTHORIZED');
    }

    try {
      await assertActorCanMutateEntity(
        transaction,
        actorUserId,
        'website',
        data.websiteId,
        PERMISSIONS.websiteUpdate,
      );
    } catch (error: any) {
      if (['ENTITY_NOT_FOUND', 'ENTITY_ACTOR_NOT_AUTHORIZED'].includes(error?.message)) {
        throw new Error('REPORT_DESTINATION_NOT_AUTHORIZED');
      }

      throw error;
    }

    return transaction.report.create({ data });
  });
}

export async function updateReport(
  reportId: string,
  data: Prisma.ReportUncheckedUpdateInput,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    const actor = await transaction.user.findFirst({
      where: {
        id: actorUserId,
        deletedAt: null,
      },
      select: {
        role: true,
      },
    });
    const report = await transaction.report.findUnique({
      where: { id: reportId },
      select: {
        userId: true,
        websiteId: true,
      },
    });

    if (!report) {
      throw new Error('REPORT_NOT_FOUND');
    }

    if (!actor) {
      throw new Error('REPORT_ACTOR_NOT_AUTHORIZED');
    }

    if (actor.role !== ROLES.admin && report.userId !== actorUserId) {
      try {
        await assertActorCanMutateEntity(
          transaction,
          actorUserId,
          'website',
          report.websiteId,
          PERMISSIONS.websiteUpdate,
        );
      } catch (error: any) {
        if (['ENTITY_NOT_FOUND', 'ENTITY_ACTOR_NOT_AUTHORIZED'].includes(error?.message)) {
          throw new Error('REPORT_ACTOR_NOT_AUTHORIZED');
        }

        throw error;
      }
    }

    const destinationWebsiteId =
      typeof data.websiteId === 'string' ? data.websiteId : report.websiteId;

    try {
      await assertActorCanMutateEntity(
        transaction,
        actorUserId,
        'website',
        destinationWebsiteId,
        PERMISSIONS.websiteUpdate,
      );
    } catch (error: any) {
      if (['ENTITY_NOT_FOUND', 'ENTITY_ACTOR_NOT_AUTHORIZED'].includes(error?.message)) {
        throw new Error('REPORT_DESTINATION_NOT_AUTHORIZED');
      }

      throw error;
    }

    return transaction.report.update({ where: { id: reportId }, data });
  });
}

export async function deleteReport(reportId: string, actorUserId: string) {
  return runSerializable(async transaction => {
    const actor = await transaction.user.findFirst({
      where: {
        id: actorUserId,
        deletedAt: null,
      },
      select: {
        role: true,
      },
    });
    const report = await transaction.report.findUnique({
      where: { id: reportId },
      select: {
        userId: true,
        websiteId: true,
      },
    });

    if (!report) {
      throw new Error('REPORT_NOT_FOUND');
    }

    if (!actor) {
      throw new Error('REPORT_ACTOR_NOT_AUTHORIZED');
    }

    if (actor.role !== ROLES.admin && report.userId !== actorUserId) {
      try {
        await assertActorCanMutateEntity(
          transaction,
          actorUserId,
          'website',
          report.websiteId,
          PERMISSIONS.websiteDelete,
        );
      } catch (error: any) {
        if (['ENTITY_NOT_FOUND', 'ENTITY_ACTOR_NOT_AUTHORIZED'].includes(error?.message)) {
          throw new Error('REPORT_ACTOR_NOT_AUTHORIZED');
        }

        throw error;
      }
    }

    return transaction.report.delete({ where: { id: reportId } });
  });
}
