import { useConfig } from '@/components/hooks';
import { Globe } from '@/components/icons';
import { GROUPED_DOMAINS } from '@/lib/constants';

function getHostName(url: string) {
  const match = url.match(/^(?:https?:\/\/)?(?:[^@\n]+@)?([^:/\n?=]+)/im);
  return match && match.length > 1 ? match[1] : null;
}

export function Favicon({ domain, ...props }) {
  const config = useConfig();

  if (config?.privateMode) {
    return null;
  }

  const hostName = domain ? getHostName(domain) : null;

  if (!hostName) {
    return null;
  }

  if (!config?.faviconUrl) {
    return <Globe width={16} height={16} aria-hidden="true" {...props} />;
  }

  const domainName = GROUPED_DOMAINS[hostName]?.domain || hostName;
  const src = config.faviconUrl.replace(/\{\{\s*domain\s*}}/, domainName);

  return <img src={src} width={16} height={16} alt="" {...props} />;
}
