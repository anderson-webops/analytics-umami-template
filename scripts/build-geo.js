import { buildGeoDatabase } from './geo-build.mjs';

const isEnabled = name =>
  ['1', 'true', 'yes', 'on'].includes(process.env[name]?.trim().toLowerCase() ?? '');

const productionBuildRequired = isEnabled('GEO_BUILD_REQUIRED');
await import('dotenv/config');

if (isEnabled('SKIP_BUILD_GEO') || (process.env.VERCEL && !isEnabled('BUILD_GEO'))) {
  if (productionBuildRequired) {
    throw new Error('A production artifact cannot skip the verified GeoIP build.');
  }

  console.log('Skipping geo setup outside the production artifact build.');
} else {
  await buildGeoDatabase();
  console.log('Verified GeoLite2-City database is ready.');
}
