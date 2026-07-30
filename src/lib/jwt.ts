import jwt from 'jsonwebtoken';
import { decrypt, encrypt } from '@/lib/crypto';
import { getBearerToken } from '@/lib/session';

export function createToken(payload: any, secret: any, options?: any) {
  return jwt.sign(payload, secret, options);
}

export function parseToken(token: string | null | undefined, secret: any) {
  if (!token) {
    return null;
  }

  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

export function createSecureToken(payload: any, secret: any, options?: any) {
  return encrypt(createToken(payload, secret, options), secret);
}

export function parseSecureToken(token: string | null | undefined, secret: any) {
  if (!token) {
    return null;
  }

  try {
    return jwt.verify(decrypt(token, secret), secret);
  } catch {
    return null;
  }
}

export async function parseAuthToken(req: Request, secret: string) {
  try {
    const token = getBearerToken(req);

    return parseSecureToken(token, secret);
  } catch {
    return null;
  }
}
