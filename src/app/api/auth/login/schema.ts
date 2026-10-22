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
    recoveryCode: z
      .string()
      .regex(/^UR-[0-9A-Fa-f]{64}$/)
      .optional()
      .meta({ description: 'Single-use account-owned code for login during a password lockout.' }),
  })
  .strict()
  .meta({ id: 'LoginRequest' });
