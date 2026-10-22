import { z } from 'zod';
import { loginPasswordParam } from '@/lib/schema';

export const rotateLoginRecoveryCodesSchema = z
  .object({
    password: loginPasswordParam.meta({ description: 'Current account password.' }),
    userId: z
      .uuid()
      .optional()
      .meta({ description: 'Target account for administrator-assisted recovery.' }),
  })
  .strict();
