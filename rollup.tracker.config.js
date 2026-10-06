import 'dotenv/config';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { getCollectBuildConfig } from './scripts/collect-build-config.mjs';

const { host, endpoint } = getCollectBuildConfig();

export default {
  input: 'src/tracker/index.ts',
  output: {
    file: 'public/script.js',
    format: 'iife',
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.tracker.json' }),
    replace({
      "process.env['COLLECT_API_HOST']": JSON.stringify(host),
      "process.env['COLLECT_API_ENDPOINT']": JSON.stringify(endpoint),
      delimiters: ['', ''],
      preventAssignment: true,
    }),
    terser({ compress: { evaluate: false } }),
  ],
};
