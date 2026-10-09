import { z } from 'zod';
import { loginPasswordParam } from '@/lib/schema';

export const loginRequestSchema = z
  .object({
    username: z.string().trim().min(1).max(255).meta({ description: 'Umami username.' }),
    password: loginPasswordParam.meta({ description: 'Umami password.' }),
    captchaToken: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .meta({ description: 'Turnstile token when login verification is configured.' }),
  })
  .strict()
  .meta({ id: 'LoginRequest' });
