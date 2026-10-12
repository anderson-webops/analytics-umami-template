import crypto from 'node:crypto';
import { startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { v4, v5, v7, validate } from 'uuid';
import { isEnvEnabled } from '@/lib/env';

const ALGORITHM = 'aes-256-gcm';
const V2_PREFIX = 'v2.';
const V2_IV_LENGTH = 12;
const TAG_LENGTH = 16;
const V2_ENC_POSITION = V2_IV_LENGTH + TAG_LENGTH;
const MAX_ENCRYPTED_VALUE_LENGTH = 8192;
let cachedFastKeySecret: string | undefined;
let cachedFastKey: Buffer | undefined;

const HASH_ALGO = 'sha512';
const HASH_ENCODING = 'hex';

function getFastKey(secret: string): Buffer {
  if (!cachedFastKey || cachedFastKeySecret !== secret) {
    cachedFastKey = crypto
      .createHmac('sha256', secret)
      .update('umami secure session encryption v2')
      .digest();
    cachedFastKeySecret = secret;
  }

  return cachedFastKey;
}

export async function encrypt(value: any, secret: any) {
  const iv = crypto.randomBytes(V2_IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getFastKey(secret), iv);

  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);

  const tag = cipher.getAuthTag();

  return `${V2_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

export async function decrypt(value: any, secret: any) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_ENCRYPTED_VALUE_LENGTH ||
    !value.startsWith(V2_PREFIX)
  ) {
    throw new Error('Invalid encrypted value');
  }

  const encoded = value.slice(V2_PREFIX.length);

  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Invalid encrypted value');
  }

  const bytes = Buffer.from(encoded, 'base64');

  if (bytes.length < V2_ENC_POSITION || bytes.toString('base64') !== encoded) {
    throw new Error('Invalid encrypted value');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getFastKey(secret),
    bytes.subarray(0, V2_IV_LENGTH),
  );
  decipher.setAuthTag(bytes.subarray(V2_IV_LENGTH, V2_ENC_POSITION));

  return decipher.update(bytes.subarray(V2_ENC_POSITION)) + decipher.final('utf8');
}

export function hash(...args: string[]) {
  return crypto.createHash(HASH_ALGO).update(args.join('')).digest(HASH_ENCODING);
}

export function md5(...args: string[]) {
  return crypto.createHash('md5').update(args.join('')).digest('hex');
}

export function secret() {
  const value = process.env.APP_SECRET?.trim();

  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('APP_SECRET must contain at least 32 UTF-8 bytes.');
  }

  return hash(value);
}

export function uuid(...args: any) {
  if (args.length) {
    return v5(hash(...args, secret()), v5.DNS);
  }

  return isEnvEnabled('USE_UUIDV7') ? v7() : v4();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && validate(value);
}

export function createAuthKey() {
  return crypto.randomBytes(16).toString('hex');
}

export function getSalt(saltRotation: string, createdAt: Date): string {
  return hash(
    (saltRotation === 'day' ? startOfDay : saltRotation === 'week' ? startOfWeek : startOfMonth)(
      createdAt,
    ).toUTCString(),
  );
}
