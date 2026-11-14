import type { Report } from '@/generated/prisma/client';
import { isEnvEnabled } from '@/lib/env';
import { getBillingAccess, getWebsiteBillingScope } from '@/lib/load';
import type { ShareSection } from '@/lib/share';
import type { Auth } from '@/lib/types';
import { getWebsite } from '@/queries/prisma';
import { canMutateResource } from './mutation';
import { canViewWebsiteSection } from './share';
import { canDeleteWebsite, canUpdateWebsite, canViewWebsite } from './website';

async function hasReportBillingAccess(report: Report) {
  if (!isEnvEnabled('CLOUD_MODE')) {
    return true;
  }

  const website = await getWebsite(report.websiteId);
  return !!website && !(await getBillingAccess(await getWebsiteBillingScope(website))).isPastDue;
}

export function getReportSection(type?: string): ShareSection | null {
  switch (type) {
    case 'attribution':
    case 'breakdown':
    case 'performance':
    case 'retention':
    case 'revenue':
    case 'utm':
      return type;
    case 'funnel':
      return 'funnels';
    case 'goal':
      return 'goals';
    case 'journey':
      return 'journeys';
    default:
      return null;
  }
}

export async function canViewReport(auth: Auth, report: Report | null) {
  if (!report) {
    return false;
  }

  if (auth.user?.isAdmin) {
    return true;
  }

  const section = getReportSection(report.type);

  const allowed = section
    ? !!(await canViewWebsiteSection(auth, report.websiteId, section))
    : !!auth.user && !!(await canViewWebsite({ user: auth.user }, report.websiteId));

  return allowed && (auth.user?.id !== report.userId || (await hasReportBillingAccess(report)));
}

export async function canUpdateReport(auth: Auth, report: Report) {
  if (!canMutateResource(auth.user)) {
    return false;
  }

  if (auth.user.isAdmin) {
    return true;
  }

  if (auth.user.id === report.userId) {
    return (
      !!(await canViewWebsite({ user: auth.user }, report.websiteId)) &&
      (await hasReportBillingAccess(report))
    );
  }

  return !!(await canUpdateWebsite(auth, report.websiteId));
}

export async function canDeleteReport(auth: Auth, report: Report) {
  if (!canMutateResource(auth.user)) {
    return false;
  }

  if (auth.user.isAdmin) {
    return true;
  }

  return (
    !!(await canDeleteWebsite(auth, report.websiteId)) &&
    (auth.user.id !== report.userId || (await hasReportBillingAccess(report)))
  );
}
