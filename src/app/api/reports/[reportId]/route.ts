import { parseRequest } from '@/lib/request';
import { json, notFound, ok, unauthorized } from '@/lib/response';
import { reportSchema } from '@/lib/schema';
import { canDeleteReport, canUpdateReport, canUpdateWebsite, canViewReport } from '@/permissions';
import { deleteReport, getReport, updateReport } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { reportId } = await params;

  const report = await getReport(reportId);

  if (!report) {
    return notFound();
  }

  if (!(await canViewReport(auth, report))) {
    return unauthorized();
  }

  if (!auth.user) {
    const { userId: _userId, ...publicReport } = report;

    return json(publicReport);
  }

  return json(report);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, reportSchema);

  if (error) {
    return error();
  }

  const { reportId } = await params;
  const { websiteId, type, name, description, parameters } = body;

  const report = await getReport(reportId);

  if (!report) {
    return notFound();
  }

  if (!(await canUpdateReport(auth, report))) {
    return unauthorized();
  }

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized({ message: 'You cannot move this report to the requested website.' });
  }

  let result;

  try {
    result = await updateReport(
      reportId,
      {
        websiteId,
        type,
        name,
        description,
        parameters,
      },
      auth.user.id,
    );
  } catch (error: any) {
    switch (error?.message) {
      case 'REPORT_NOT_FOUND':
        return notFound();
      case 'REPORT_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your report-update permission changed.' });
      case 'REPORT_DESTINATION_NOT_AUTHORIZED':
        return unauthorized({ message: 'You cannot move this report to the requested website.' });
      default:
        throw error;
    }
  }

  return json(result);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { reportId } = await params;
  const report = await getReport(reportId);

  if (!report) {
    return notFound();
  }

  if (!(await canDeleteReport(auth, report))) {
    return unauthorized();
  }

  try {
    await deleteReport(reportId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'REPORT_NOT_FOUND':
        return notFound();
      case 'REPORT_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your report-deletion permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
