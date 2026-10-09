import { z } from 'zod';
import { loginPasswordParam } from '@/lib/schema';

export const initiateTwoFactorSetupSchema = z
  .object({ password: loginPasswordParam.meta({ description: 'Current account password.' }) })
  .strict();
