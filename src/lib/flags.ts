import { evaluate } from 'flags/next';
import { type FlagValues, flags, getDefaultFlagValues } from './flag-definitions';

export type { FlagKey, FlagValues } from './flag-definitions';
export { flags, getDefaultFlagValues } from './flag-definitions';

/**
 * Whether a flag key is listed in FEATURE_FLAGS, a comma-separated list of enabled flags,
 * e.g. `FEATURE_FLAGS=example,other`. Whitespace and case are ignored.
 */
export function isFeatureEnabled(key: string): boolean {
  return (process.env.FEATURE_FLAGS ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(key.toLowerCase());
}

/**
 * Evaluates every flag for the current request, respecting Flags Explorer overrides.
 * Falls back to default values rather than failing the page, for example when an
 * override cookie is present but FLAGS_SECRET is not set.
 */
export async function getFlagValues(): Promise<FlagValues> {
  try {
    return (await evaluate(flags)) as FlagValues;
  } catch (error) {
    console.error('Failed to evaluate feature flags, using defaults.', error);
    return getDefaultFlagValues();
  }
}
