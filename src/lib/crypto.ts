import crypto from 'node:crypto';
import { startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { v4, v5, v7, validate } from 'uuid';
import { isEnvEnabled } from '@/lib/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENC_POSITION = TAG_POSITION + TAG_LENGTH;
const MAX_ENCRYPTED_VALUE_LENGTH = 8192;
const MAX_CONCURRENT_DECRYPTIONS = 64;
let activeDecryptions = 0;

const HASH_ALGO = 'sha512';
const HASH_ENCODING = 'hex';

const getKey = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(password, salt, 10000, 32, 'sha512', (error, derivedKey) => {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey);
      }
    });
  });

export async function encrypt(value: any, secret: any) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await getKey(secret, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);

  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

export async function decrypt(value: any, secret: any) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_ENCRYPTED_VALUE_LENGTH ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error('Invalid encrypted value');
  }

  const str = Buffer.from(value, 'base64');
  if (str.length < ENC_POSITION || str.toString('base64') !== value) {
    throw new Error('Invalid encrypted value');
  }

  const salt = str.subarray(0, SALT_LENGTH);
  const iv = str.subarray(SALT_LENGTH, TAG_POSITION);
  const tag = str.subarray(TAG_POSITION, ENC_POSITION);
  const encrypted = str.subarray(ENC_POSITION);

  if (activeDecryptions >= MAX_CONCURRENT_DECRYPTIONS) {
    throw new Error('Too many concurrent decryptions');
  }

  activeDecryptions++;

  try {
    const key = await getKey(secret, salt);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    decipher.setAuthTag(tag);

    return decipher.update(encrypted) + decipher.final('utf8');
  } finally {
    activeDecryptions--;
  }
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
