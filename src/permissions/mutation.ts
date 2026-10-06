import { ROLES } from '@/lib/constants';
import type { Auth } from '@/lib/types';

export function canMutateResource(user: Auth['user']): user is NonNullable<Auth['user']> {
  return (
    !!user &&
    ((user.role === ROLES.admin && user.isAdmin) || (user.role === ROLES.user && !user.isAdmin))
  );
}
