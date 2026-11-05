import { z } from 'zod';
import { loginPasswordParam } from '@/lib/schema';

const prepareLoginRecoveryCodesSchema = z
  .object({
    action: z.literal('prepare'),
    password: loginPasswordParam.meta({ description: 'Current account password.' }),
    userId: z
      .uuid()
      .optional()
      .meta({ description: 'Target account for administrator-assisted recovery.' }),
  })
  .strict();

export const confirmLoginRecoveryCodesSchema = z
  .object({
    action: z.literal('confirm'),
    password: loginPasswordParam,
    recoveryCode: z.string().regex(/^UR-[0-9a-f]{64}$/i),
    saved: z.literal(true),
  })
  .strict();

export const rotateLoginRecoveryCodesSchema = z.union([
  prepareLoginRecoveryCodesSchema,
  confirmLoginRecoveryCodesSchema,
]);
