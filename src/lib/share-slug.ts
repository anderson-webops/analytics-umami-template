import { randomBytes } from 'node:crypto';

export function getRandomShareSlug() {
  return randomBytes(18).toString('base64url');
}
