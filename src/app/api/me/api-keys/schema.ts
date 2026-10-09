import { z } from 'zod';
import { loginPasswordParam } from '@/lib/schema';

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    currentPassword: loginPasswordParam.meta({ description: 'Current account password.' }),
  })
  .strict();
