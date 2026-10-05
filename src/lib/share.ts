import type { ShareParameters, ShareTheme } from './types';

export { excludeShareFilterParam } from './share-filter';

const SHARE_SECTIONS = [
  'overview',
  'events',
  'sessions',
  'realtime',
  'performance',
  'compare',
  'breakdown',
  'goals',
  'funnels',
  'journeys',
  'retention',
  'utm',
  'revenue',
  'attribution',
] as const;

export type ShareSection = (typeof SHARE_SECTIONS)[number];

export function canViewShareSection(
  parameters: ShareParameters | null | undefined,
  section: ShareSection | ShareSection[],
) {
  const hasSectionParameters = SHARE_SECTIONS.some(key => typeof parameters?.[key] === 'boolean');

  if (!hasSectionParameters) {
    return true;
  }

  const sections = Array.isArray(section) ? section : [section];

  return sections.some(key => parameters?.[key] === true);
}

export function allowShareFilter(parameters?: ShareParameters | null) {
  return parameters?.allowFilter !== false;
}

export function getShareTheme(parameters?: ShareParameters | null): ShareTheme | undefined {
  return parameters?.theme === 'light' || parameters?.theme === 'dark'
    ? parameters.theme
    : undefined;
}
