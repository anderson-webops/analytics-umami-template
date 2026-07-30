import { isEnvEnabled } from '@/lib/env';
import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { publicSharesDisabled } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { error } = await parseRequest(request, null, { skipAuth: true });

  if (error) {
    return error();
  }

  return json({
    cloudMode: isEnvEnabled('CLOUD_MODE'),
    faviconUrl: process.env.FAVICON_URL,
    linksUrl: process.env.LINKS_URL,
    pixelsUrl: process.env.PIXELS_URL,
    privateMode: isEnvEnabled('PRIVATE_MODE'),
    publicSharesDisabled: publicSharesDisabled(),
    trackerScriptName: process.env.TRACKER_SCRIPT_NAME,
    updatesDisabled: isEnvEnabled('DISABLE_UPDATES') || !isEnvEnabled('ENABLE_UPDATE_CHECKS'),
  });
}
