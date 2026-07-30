import type { ShareParameters, ShareTheme } from './types';

export { excludeShareFilterParam } from './share-filter';

export function allowShareFilter(parameters?: ShareParameters | null) {
  return parameters?.allowFilter !== false;
}

export function getShareTheme(parameters?: ShareParameters | null): ShareTheme | undefined {
  return parameters?.theme === 'light' || parameters?.theme === 'dark'
    ? parameters.theme
    : undefined;
}
