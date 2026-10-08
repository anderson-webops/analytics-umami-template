import { ROLES } from '@/lib/constants';
import type { Auth } from '@/lib/types';

export function hasMutableGlobalRole(role: string | null | undefined): boolean {
  return role === ROLES.admin || role === ROLES.user;
}

export function canMutateResource(user: Auth['user']): user is NonNullable<Auth['user']> {
  return !!user && hasMutableGlobalRole(user.role) && user.isAdmin === (user.role === ROLES.admin);
}
