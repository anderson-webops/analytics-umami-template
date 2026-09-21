import type { Annotation, Prisma } from '@/generated/prisma/client';
import { PERMISSIONS } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { PageResult, QueryFilters } from '@/lib/types';
import { assertActorCanMutateEntity, runSerializable } from './authorization';

export async function getAnnotation(annotationId: string) {
  return prisma.client.annotation.findUnique({
    where: {
      id: annotationId,
    },
  });
}

export async function getWebsiteAnnotation(websiteId: string, annotationId: string) {
  return prisma.client.annotation.findFirst({
    where: { id: annotationId, websiteId },
  });
}

export async function getWebsiteAnnotations(
  websiteId: string,
  filters: QueryFilters & { startDate?: Date; endDate?: Date } = {},
): Promise<PageResult<Annotation[]>> {
  const { search, startDate, endDate } = filters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where: Prisma.AnnotationWhereInput = {
    websiteId,
    ...(startDate &&
      endDate && {
        date: {
          gte: startDate,
          lte: endDate,
        },
      }),
    ...getSearchParameters(search, [
      {
        note: 'contains',
      },
    ]),
  };

  return pagedQuery(
    'annotation',
    {
      where,
      orderBy: {
        date: 'desc',
      },
    },
    filters,
  );
}

export async function createAnnotation(
  data: Prisma.AnnotationUncheckedCreateInput,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'website',
      data.websiteId,
      PERMISSIONS.websiteUpdate,
    );

    return transaction.annotation.create({ data });
  });
}

export async function updateAnnotation(
  websiteId: string,
  annotationId: string,
  data: Prisma.AnnotationUpdateInput,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'website',
      websiteId,
      PERMISSIONS.websiteUpdate,
    );

    const annotation = await transaction.annotation.findFirst({
      where: { id: annotationId, websiteId },
      select: { id: true },
    });

    if (!annotation) {
      throw new Error('ANNOTATION_NOT_FOUND');
    }

    return transaction.annotation.update({ where: { id: annotationId }, data });
  });
}

export async function deleteAnnotation(
  websiteId: string,
  annotationId: string,
  actorUserId: string,
) {
  return runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorUserId,
      'website',
      websiteId,
      PERMISSIONS.websiteUpdate,
    );

    const annotation = await transaction.annotation.findFirst({
      where: { id: annotationId, websiteId },
      select: { id: true },
    });

    if (!annotation) {
      throw new Error('ANNOTATION_NOT_FOUND');
    }

    return transaction.annotation.delete({ where: { id: annotationId } });
  });
}
