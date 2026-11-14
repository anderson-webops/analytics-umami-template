import type { flag } from 'flags/next';

export const flags: Record<string, ReturnType<typeof flag<boolean>>> = {};

export type FlagKey = keyof typeof flags;

export type FlagValues = {
  [K in FlagKey]: Awaited<ReturnType<(typeof flags)[K]>>;
};

export function getDefaultFlagValues(): FlagValues {
  return Object.fromEntries(
    Object.entries(flags).map(([key, definition]) => [key, definition.defaultValue]),
  ) as FlagValues;
}
