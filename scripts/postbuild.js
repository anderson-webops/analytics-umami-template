import 'dotenv/config';
import { repairStandaloneRuntime } from './repair-standalone.js';

async function run() {
  await repairStandaloneRuntime();
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
