import { expect, test } from 'vitest';
import { handleReportMutationError } from './report-mutation';

test.each(['REPORT_ACTOR_NOT_AUTHORIZED', 'REPORT_DESTINATION_NOT_AUTHORIZED'])(
  'maps %s to an authorization response',
  async message => {
    const response = handleReportMutationError(new Error(message));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unauthorized', message: 'Your report permission changed.' },
    });
  },
);

test('maps a report removed during a mutation to not found', async () => {
  const response = handleReportMutationError(new Error('REPORT_NOT_FOUND'));

  expect(response.status).toBe(404);
});

test('rethrows unexpected errors', () => {
  const error = new Error('DATABASE_UNAVAILABLE');

  expect(() => handleReportMutationError(error)).toThrow(error);
});
