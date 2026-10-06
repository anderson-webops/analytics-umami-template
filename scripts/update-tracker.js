/* eslint-disable no-console */
import 'dotenv/config';
import { rollup } from 'rollup';
import config from '../rollup.tracker.config.js';

const endpoint = process.env.COLLECT_API_ENDPOINT;

if (endpoint) {
  const bundle = await rollup(config);

  try {
    await bundle.write(config.output);
  } finally {
    await bundle.close();
  }

  console.log('Updated tracker endpoint.');
}
