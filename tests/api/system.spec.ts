import { expect, test } from './fixtures';

test.describe('System', () => {
  test('GET /api/heartbeat responds without authentication', async ({ api }) => {
    const response = await api.get('/api/heartbeat');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  test('GET /api/config reports the runtime feature flags', async ({ api, seed }) => {
    const response = await api.get('/api/config');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      cloudMode: false,
      privateMode: false,
      // Session deletion is only supported when analytics live in Postgres.
      sessionDeletionEnabled: seed.db === 'postgres',
    });
    expect(typeof response.body.telemetryDisabled).toBe('boolean');
    expect(typeof response.body.updatesDisabled).toBe('boolean');
  });

  test('GET /api/scripts/telemetry is unavailable when telemetry is disabled', async ({ api }) => {
    const config = await api.get('/api/config');
    const response = await api.get('/api/scripts/telemetry');

    expect(config.body.telemetryDisabled).toBe(true);
    expect(response.status).toBe(404);
  });
});
