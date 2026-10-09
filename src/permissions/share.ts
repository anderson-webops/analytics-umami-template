import { ENTITY_TYPE } from '@/lib/constants';
import { canViewShareSection, type ShareSection } from '@/lib/share';
import type { Auth } from '@/lib/types';
import { canDeleteBoard, canUpdateBoard, canViewBoard } from './board';
import { canDeleteLink, canUpdateLink, canViewLink } from './link';
import { canDeletePixel, canUpdatePixel, canViewPixel } from './pixel';
import { canDeleteWebsite, canUpdateWebsite, canViewWebsite } from './website';

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

async function canViewWebsiteAsUser(auth: Auth | null | undefined, websiteId: string) {
  return auth?.user ? canViewWebsite({ user: auth.user }, websiteId) : false;
}

export async function canViewWebsiteSection(
  auth: Auth | null | undefined,
  websiteId: string,
  section: ShareSectionInput,
) {
  if (await canViewWebsiteAsUser(auth, websiteId)) {
    return true;
  }

  const shareAuth = { shareToken: auth?.shareToken };
  const { shareToken } = shareAuth;

  if (!shareToken || !shareTokenIncludesWebsite(shareAuth, websiteId)) {
    return false;
  }

  if (shareToken.shareType === ENTITY_TYPE.website) {
    return (
      (await canViewWebsite(shareAuth, websiteId)) &&
      canViewShareSection(shareToken.parameters, section)
    );
  }

  if (shareToken.scopedApiAccess !== true) {
    return false;
  }

  return canViewShareSection(shareToken.parameters, section);
}

export async function canViewSharedWebsite(auth: Auth | null | undefined, websiteId: string) {
  if (await canViewWebsiteAsUser(auth, websiteId)) {
    return true;
  }

  const shareAuth = { shareToken: auth?.shareToken };

  return shareAuth.shareToken?.shareType === ENTITY_TYPE.website
    ? canViewWebsite(shareAuth, websiteId)
    : shareAuth.shareToken?.scopedApiAccess === true &&
        shareTokenIncludesWebsite(shareAuth, websiteId);
}

export async function canViewSharedWebsiteFilters(
  auth: Auth | null | undefined,
  websiteId: string,
) {
  if (await canViewWebsiteAsUser(auth, websiteId)) {
    return true;
  }

  const shareAuth = { shareToken: auth?.shareToken };

  return (
    shareAuth.shareToken?.shareType === ENTITY_TYPE.website &&
    shareTokenIncludesWebsite(shareAuth, websiteId) &&
    shareAuth.shareToken?.parameters?.allowFilter !== false &&
    (await canViewWebsite(shareAuth, websiteId))
  );
}

export async function canViewAuthenticatedWebsite(
  auth: Auth | null | undefined,
  websiteId: string,
) {
  return canViewWebsiteAsUser(auth, websiteId);
}

export async function canViewWebsiteAnnotations(auth: Auth | null | undefined, websiteId: string) {
  if (auth?.user && (await canViewWebsite({ user: auth.user }, websiteId))) {
    return true;
  }

  const shareAuth = { shareToken: auth?.shareToken };

  return (
    (await canViewSharedWebsiteFilters(shareAuth, websiteId)) &&
    (await canViewWebsiteSection(shareAuth, websiteId, ['overview', 'compare']))
  );
}
