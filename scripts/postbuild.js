import 'dotenv/config';
import { repairStandaloneRuntime } from './repair-standalone.js';
import { sendTelemetry } from './telemetry.js';

async function run() {
  if (!process.env.DISABLE_TELEMETRY) {
    await sendTelemetry('build');
  }

  await repairStandaloneRuntime();
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
