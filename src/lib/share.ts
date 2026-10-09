import type { Auth, ShareParameters, ShareTheme } from './types';

export { excludeShareFilterParam } from './share-filter';

export const SHARE_SECTIONS = [
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

const METRIC_SHARE_SECTIONS: Record<string, ShareSection[]> = {
  path: ['overview', 'compare'],
  fullPath: ['overview'],
  entry: ['overview'],
  exit: ['overview'],
  referrer: ['overview', 'compare'],
  domain: ['overview'],
  title: ['overview'],
  query: ['overview'],
  hostname: ['overview', 'compare'],
  channel: ['overview', 'compare'],
  event: ['compare', 'events'],
  tag: ['compare', 'events'],
  utmSource: ['compare', 'utm'],
  utmMedium: ['compare', 'utm'],
  utmCampaign: ['compare', 'utm'],
  utmContent: ['compare', 'utm'],
  utmTerm: ['compare', 'utm'],
  browser: ['overview', 'compare', 'sessions'],
  os: ['overview', 'compare', 'sessions'],
  device: ['overview', 'compare', 'sessions'],
  screen: ['compare', 'sessions'],
  language: ['compare', 'sessions'],
  country: ['overview', 'compare', 'sessions'],
  city: ['overview', 'compare', 'sessions'],
  region: ['overview', 'compare', 'sessions'],
  distinctId: ['compare', 'sessions'],
};

export function getMetricShareSections(type: string): ShareSection[] | null {
  return Object.hasOwn(METRIC_SHARE_SECTIONS, type) ? METRIC_SHARE_SECTIONS[type] : null;
}

export function getValueShareSections(type: string, allowFilter: boolean): ShareSection[] | null {
  const metricSections = getMetricShareSections(type);

  if (!metricSections) {
    return null;
  }

  if (type === 'path' || type === 'event') {
    const selectorSections: ShareSection[] = ['journeys', 'attribution'];
    return allowFilter ? [...metricSections, ...selectorSections] : selectorSections;
  }

  return allowFilter ? metricSections : null;
}

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

export function restrictShareAuthToSection(
  auth: Auth,
  section: ShareSection | ShareSection[],
): Auth {
  return auth.shareToken && !canViewShareSection(auth.shareToken.parameters, section)
    ? { ...auth, shareToken: undefined }
    : auth;
}

export function allowShareFilter(parameters?: ShareParameters | null) {
  return parameters?.allowFilter !== false;
}

export function getShareTheme(parameters?: ShareParameters | null): ShareTheme | undefined {
  return parameters?.theme === 'light' || parameters?.theme === 'dark'
    ? parameters.theme
    : undefined;
}
