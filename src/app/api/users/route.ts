import { z } from 'zod';
import { ROLES } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { hashPassword } from '@/lib/password';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { passwordParam, userRoleParam } from '@/lib/schema';
import { canCreateUser } from '@/permissions';
import { createUser, getUserByUsername } from '@/queries/prisma';

export async function POST(request: Request) {
  const schema = z.object({
    id: z.uuid().optional(),
    username: z.string().trim().min(1).max(255),
    password: passwordParam,
    role: userRoleParam,
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  if (!(await canCreateUser(auth))) {
    return unauthorized();
  }

  const { id, username, password, role } = body;

  const existingUser = await getUserByUsername(username, { showDeleted: true });

  if (existingUser) {
    return badRequest({ message: 'User already exists' });
  }

  let user;

  try {
    user = await createUser(
      {
        id: id || uuid(),
        username: username.toLowerCase(),
        password: await hashPassword(password),
        role: role ?? ROLES.user,
      },
      auth.user.id,
    );
  } catch (error: any) {
    if (error?.message === 'ADMIN_AUTHORIZATION_CHANGED') {
      return unauthorized({ message: 'Your administrator permission changed.' });
    }

    if (error?.code === 'P2002') {
      return badRequest({ message: 'User already exists' });
    }

    throw error;
  }

  return json(user);
}
