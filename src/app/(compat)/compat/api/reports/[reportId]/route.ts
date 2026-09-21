import { handleReportMutationError } from '@/lib/report-mutation';
import { parseRequest } from '@/lib/request';
import { json, notFound, ok, unauthorized } from '@/lib/response';
import { reportSchema } from '@/lib/schema';
import { canDeleteReport, canUpdateReport, canViewReport } from '@/permissions';
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
  const { type, name, description, parameters } = body;

  const report = await getReport(reportId);

  if (!report) {
    return notFound();
  }

  if (!(await canUpdateReport(auth, report))) {
    return unauthorized();
  }

  // Reports cannot be relocated to another website via update.
  // The body websiteId is intentionally ignored.
  try {
    return json(
      await updateReport(
        reportId,
        {
          type,
          name,
          description,
          parameters,
        } as any,
        auth.user.id,
      ),
    );
  } catch (error) {
    return handleReportMutationError(error);
  }
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
    return ok();
  } catch (error) {
    return handleReportMutationError(error);
  }
}
