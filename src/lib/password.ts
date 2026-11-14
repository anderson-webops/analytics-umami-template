import bcrypt from 'bcryptjs';
import { isEnvEnabled } from '@/lib/env';

const SYSTEM_USER_ID = '41e2b680-648e-4b09-bcd7-3e2b10c06264';
const SYSTEM_USER_PASSWORD_HASH = '$2b$10$BUli0c.muyCW1ErNJc3jL.vFRFtFJWrT8/GcR4A.sUdCznaXiqFXa';

const SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;
const COMMON_PASSWORDS = new Set([
  '123456789012',
  'adminadminadmin',
  'letmeinletmein',
  'password1234',
  'passwordpassword',
  'qwertyuiop12',
  'umamiumamiumami',
]);

export function hashPassword(password: string, rounds = SALT_ROUNDS) {
  return bcrypt.hash(password, rounds);
}

export function checkPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function passwordNeedsRehash(passwordHash: string): boolean {
  try {
    return bcrypt.getRounds(passwordHash) < SALT_ROUNDS;
  } catch {
    return true;
  }
}

export function isAcceptableLoginPassword(password: string): boolean {
  return password.length > 0 && Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES;
}

export function isStrongPassword(password: string): boolean {
  const normalized = password.normalize('NFKC').toLowerCase();

  return (
    password.length >= MIN_PASSWORD_LENGTH &&
    Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES &&
    !COMMON_PASSWORDS.has(normalized) &&
    !/^(.)\1+$/u.test(normalized)
  );
}

export function hasDefaultPassword(user: { id: string; password: string } | null | undefined) {
  return (
    !isEnvEnabled('CLOUD_MODE') &&
    user?.id === SYSTEM_USER_ID &&
    user.password === SYSTEM_USER_PASSWORD_HASH
  );
}
