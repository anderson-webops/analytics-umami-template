import { ENTITY_TYPE } from '@/lib/constants';
import type { Auth } from '@/lib/types';
import { canDeleteBoard, canUpdateBoard, canViewBoard } from './board';
import { canDeleteLink, canUpdateLink, canViewLink } from './link';
import { canDeletePixel, canUpdatePixel, canViewPixel } from './pixel';
import { canDeleteWebsite, canUpdateWebsite, canViewWebsite } from './website';

export type ShareSection =
  | 'overview'
  | 'events'
  | 'sessions'
  | 'realtime'
  | 'performance'
  | 'compare'
  | 'breakdown'
  | 'goals'
  | 'funnels'
  | 'journeys'
  | 'retention'
  | 'utm'
  | 'revenue'
  | 'attribution';

const SHARE_SECTIONS: ShareSection[] = [
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
];

type ShareSectionInput = ShareSection | ShareSection[];
type SharePermission = (auth: Auth, entityId: string) => Promise<boolean>;

function getSharePermission(
  shareType: number,
  permissions: {
    website: SharePermission;
    link: SharePermission;
    pixel: SharePermission;
    board: SharePermission;
  },
) {
  if (shareType === ENTITY_TYPE.website) return permissions.website;
  if (shareType === ENTITY_TYPE.link) return permissions.link;
  if (shareType === ENTITY_TYPE.pixel) return permissions.pixel;
  if (shareType === ENTITY_TYPE.board) return permissions.board;

  return null;
}

async function checkShareEntityPermission(
  auth: Auth,
  shareType: number,
  entityId: string,
  permissions: {
    website: SharePermission;
    link: SharePermission;
    pixel: SharePermission;
    board: SharePermission;
  },
) {
  const permission = getSharePermission(shareType, permissions);

  return permission ? permission(auth, entityId) : false;
}

export async function canViewShareEntity(auth: Auth, shareType: number, entityId: string) {
  return checkShareEntityPermission(auth, shareType, entityId, {
    website: canViewWebsite,
    link: canViewLink,
    pixel: canViewPixel,
    board: canViewBoard,
  });
}

export async function canUpdateShareEntity(auth: Auth, shareType: number, entityId: string) {
  return checkShareEntityPermission(auth, shareType, entityId, {
    website: canUpdateWebsite,
    link: canUpdateLink,
    pixel: canUpdatePixel,
    board: canUpdateBoard,
  });
}

export async function canDeleteShareEntity(auth: Auth, shareType: number, entityId: string) {
  return checkShareEntityPermission(auth, shareType, entityId, {
    website: canDeleteWebsite,
    link: canDeleteLink,
    pixel: canDeletePixel,
    board: canDeleteBoard,
  });
}

function shareTokenIncludesWebsite(auth: Auth | null | undefined, websiteId: string) {
  const { shareToken } = auth || {};

  return (
    shareToken?.websiteId === websiteId ||
    shareToken?.pixelId === websiteId ||
    shareToken?.linkId === websiteId ||
    shareToken?.websiteIds?.includes(websiteId) ||
    shareToken?.pixelIds?.includes(websiteId) ||
    shareToken?.linkIds?.includes(websiteId)
  );
}

export async function canViewWebsiteSection(
  auth: Auth | null | undefined,
  websiteId: string,
  section: ShareSectionInput,
) {
  if (auth?.user) {
    return canViewWebsite(auth, websiteId);
  }

  const { shareToken } = auth || {};

  if (
    !shareToken ||
    !shareTokenIncludesWebsite(auth, websiteId) ||
    !(await canViewWebsite(auth || {}, websiteId))
  ) {
    return false;
  }

  const sections = Array.isArray(section) ? section : [section];
  const hasSectionParameters = SHARE_SECTIONS.some(
    key => typeof shareToken.parameters?.[key] === 'boolean',
  );

  if (!hasSectionParameters) {
    return true;
  }

  return sections.some(key => shareToken.parameters?.[key] === true);
}

export async function canViewSharedWebsite(auth: Auth | null | undefined, websiteId: string) {
  return canViewWebsite(auth || {}, websiteId);
}

export async function canViewSharedWebsiteFilters(
  auth: Auth | null | undefined,
  websiteId: string,
) {
  if (auth?.user) {
    return canViewWebsite(auth, websiteId);
  }

  return (
    shareTokenIncludesWebsite(auth, websiteId) &&
    auth?.shareToken?.parameters?.allowFilter !== false &&
    (await canViewWebsite(auth || {}, websiteId))
  );
}

export async function canViewAuthenticatedWebsite(
  auth: Auth | null | undefined,
  websiteId: string,
) {
  if (!auth?.user) {
    return false;
  }

  return canViewWebsite(auth, websiteId);
}
