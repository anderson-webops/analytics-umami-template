import { parseRequest } from '@/lib/request';
import { notFound, ok, unauthorized } from '@/lib/response';
import { canUpdateWebsite } from '@/permissions';
import { resetWebsite } from '@/queries/prisma';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  try {
    await resetWebsite(websiteId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_NOT_FOUND':
        return notFound({ message: 'Website not found.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your website-reset permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
