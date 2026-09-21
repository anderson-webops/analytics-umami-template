import { funnelDefinitionSchema } from '@/lib/analytics-schema';
import { handleReportMutationError } from '@/lib/report-mutation';
import { parseRequest } from '@/lib/request';
import { json, notFound, ok, unauthorized } from '@/lib/response';
import { canDeleteReport, canUpdateReport, canViewReport } from '@/permissions';
import { deleteReport, getReport, updateReport } from '@/queries/prisma';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; funnelId: string }> },
) {
  const { auth, error } = await parseRequest(request);
  if (error) return error();
  const { websiteId, funnelId } = await params;
  const report = await getReport(funnelId);
  if (!report || report.websiteId !== websiteId || report.type !== 'funnel') return notFound();
  if (!(await canViewReport(auth, report))) return unauthorized();
  return json(report);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; funnelId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, funnelDefinitionSchema);
  if (error) return error();
  const { websiteId, funnelId } = await params;
  const report = await getReport(funnelId);
  if (!report || report.websiteId !== websiteId || report.type !== 'funnel') return notFound();
  if (!(await canUpdateReport(auth, report))) return unauthorized();
  try {
    return json(
      await updateReport(
        report.id,
        {
          name: body.name,
          description: body.description,
          parameters: body.parameters,
        },
        auth.user.id,
      ),
    );
  } catch (error) {
    return handleReportMutationError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; funnelId: string }> },
) {
  const { auth, error } = await parseRequest(request);
  if (error) return error();
  const { websiteId, funnelId } = await params;
  const report = await getReport(funnelId);
  if (!report || report.websiteId !== websiteId || report.type !== 'funnel') return notFound();
  if (!(await canDeleteReport(auth, report))) return unauthorized();
  try {
    await deleteReport(report.id, auth.user.id);
    return ok();
  } catch (error) {
    return handleReportMutationError(error);
  }
}
