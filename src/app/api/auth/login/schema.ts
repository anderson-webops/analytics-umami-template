import { z } from 'zod';
import { loginPasswordParam } from '@/lib/schema';

export const loginRequestSchema = z
  .object({
    username: z.string().trim().min(1).max(255).meta({ description: 'Umami username.' }),
    password: loginPasswordParam.meta({ description: 'Umami password.' }),
  })
  .strict()
  .meta({ id: 'LoginRequest' });
