import { z } from 'zod';
import { loginPasswordParam } from '@/lib/schema';

export const confirmTwoFactorSetupSchema = z
  .object({
    token: z.string().length(6),
    password: loginPasswordParam.meta({ description: 'Current account password.' }),
  })
  .strict();
