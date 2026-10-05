import { FILTER_COLUMNS } from '@/lib/constants';

const SHARE_FILTER_QUERY_PARAMS = new Set([
  'cohort',
  'excludeBounce',
  'match',
  'minDuration',
  'search',
  'segment',
  'trafficType',
]);

export function excludeShareFilterParam(key: string): boolean {
  const baseName = key.replace(/\d+$/, '');

  return (
    baseName in FILTER_COLUMNS ||
    SHARE_FILTER_QUERY_PARAMS.has(key) ||
    /^pf_[A-Za-z0-9_-]+$/.test(key) ||
    /^(?:epf|spf)\d+$/.test(key)
  );
}

export function hasShareFilterParams(value: unknown, allowSearch = false): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.keys(value).some(
    key => !(allowSearch && key === 'search') && excludeShareFilterParam(key),
  );
}
