import { notFound, unauthorized } from '@/lib/response';

export function handleReportMutationError(error: unknown): Response {
  const message = error instanceof Error ? error.message : undefined;

  switch (message) {
    case 'REPORT_NOT_FOUND':
      return notFound();
    case 'REPORT_ACTOR_NOT_AUTHORIZED':
    case 'REPORT_DESTINATION_NOT_AUTHORIZED':
      return unauthorized({ message: 'Your report permission changed.' });
    default:
      throw error;
  }
}
