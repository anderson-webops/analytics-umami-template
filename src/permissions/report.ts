import type { Report } from '@/generated/prisma/client';
import type { Auth } from '@/lib/types';
import type { ShareSection } from './share';
import { canViewWebsiteSection } from './share';
import { canDeleteWebsite, canUpdateWebsite, canViewWebsite } from './website';

export function getReportShareSection(type: string): ShareSection | null {
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

export async function canViewReport(auth: Auth, report: Report) {
  if (auth.user?.isAdmin) {
    return true;
  }

  if (auth.user?.id === report.userId) {
    return true;
  }

  if (!auth.user) {
    const section = getReportShareSection(report.type);

    return section ? canViewWebsiteSection(auth, report.websiteId, section) : false;
  }

  return !!(await canViewWebsite(auth, report.websiteId));
}

export async function canUpdateReport(auth: Auth, report: Report) {
  if (!auth.user) {
    return false;
  }

  if (auth.user.isAdmin) {
    return true;
  }

  if (auth.user.id === report.userId) {
    return true;
  }

  return !!(await canUpdateWebsite(auth, report.websiteId));
}

export async function canDeleteReport(auth: Auth, report: Report) {
  if (!auth.user) {
    return false;
  }

  if (auth.user.isAdmin) {
    return true;
  }

  if (auth.user.id === report.userId) {
    return true;
  }

  return !!(await canDeleteWebsite(auth, report.websiteId));
}
