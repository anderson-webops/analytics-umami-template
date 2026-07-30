import { z } from 'zod';
import { isUuid } from '@/lib/crypto';
import { hashPassword } from '@/lib/password';
import { parseRequest } from '@/lib/request';
import { badRequest, forbidden, json, notFound, ok, unauthorized } from '@/lib/response';
import { passwordParam, userRoleParam } from '@/lib/schema';
import { canDeleteUser, canUpdateUser, canViewUser } from '@/permissions';
import {
  deleteUser,
  getUser,
  getUserByUsername,
  isLastActiveAdminError,
  isUserDeletionBlockedError,
  updateUser,
} from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { userId } = await params;

  if (!isUuid(userId)) {
    return badRequest({ message: 'Invalid user identifier.' });
  }

  if (!(await canViewUser(auth, userId))) {
    return unauthorized();
  }

  const user = await getUser(userId);

  return json(user);
}

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const schema = z.object({
    username: z.string().trim().min(1).max(255).optional(),
    password: passwordParam.optional(),
    role: userRoleParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { userId } = await params;

  if (!isUuid(userId)) {
    return badRequest({ message: 'Invalid user identifier.' });
  }

  if (!(await canUpdateUser(auth, userId))) {
    return unauthorized();
  }

  const { username, password, role } = body;

  const user = await getUser(userId);

  if (!user) {
    return notFound();
  }

  const data: any = {};

  if (password) {
    if (!auth.user.isAdmin) {
      return forbidden({ message: 'Use the current-password flow to change your password.' });
    }

    data.password = await hashPassword(password);
  }

  // Only admin can change these fields
  if (role && auth.user.isAdmin) {
    data.role = role;
  }

  if (username && auth.user.isAdmin) {
    data.username = username.toLowerCase();
  }

  if (!auth.user.isAdmin && (username || role)) {
    return forbidden({ message: 'Only an administrator can change account identity or role.' });
  }

  if (Object.keys(data).length === 0) {
    return badRequest({ message: 'No permitted account changes were provided.' });
  }

  // Check when username changes
  if (data.username && user.username !== data.username) {
    const existingUser = await getUserByUsername(data.username);

    if (existingUser && existingUser.id !== userId) {
      return badRequest({ message: 'User already exists' });
    }
  }

  let updated;

  try {
    updated = await updateUser(userId, data, auth.user.id);
  } catch (error) {
    if (isLastActiveAdminError(error)) {
      return badRequest({ message: 'The final active administrator cannot be demoted.' });
    }

    if (error instanceof Error && error.message === 'ADMIN_AUTHORIZATION_CHANGED') {
      return unauthorized({ message: 'Your administrator permission changed.' });
    }

    if ((error as any)?.code === 'P2002') {
      return badRequest({ message: 'User already exists' });
    }

    throw error;
  }

  return json(updated);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { userId } = await params;

  if (!isUuid(userId)) {
    return badRequest({ message: 'Invalid user identifier.' });
  }

  if (!(await canDeleteUser(auth))) {
    return unauthorized();
  }

  if (userId === auth.user.id) {
    return badRequest({ message: 'You cannot delete yourself.' });
  }

  try {
    await deleteUser(userId, auth.user.id);
  } catch (error) {
    if (isLastActiveAdminError(error)) {
      return badRequest({ message: 'The final active administrator cannot be deleted.' });
    }

    if (isUserDeletionBlockedError(error)) {
      return badRequest({
        message:
          'Transfer or delete this user’s teams, websites, links, pixels, and boards before deleting the account.',
      });
    }

    if (error instanceof Error && error.message === 'ADMIN_AUTHORIZATION_CHANGED') {
      return unauthorized({ message: 'Your administrator permission changed.' });
    }

    if (error instanceof Error && error.message === 'ADMIN_CANNOT_DELETE_SELF') {
      return badRequest({ message: 'You cannot delete yourself.' });
    }

    throw error;
  }

  return ok();
}
