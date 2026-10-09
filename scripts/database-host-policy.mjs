import ipaddr from 'ipaddr.js';

const LOCAL_DATABASE_HOSTS = new Set(['localhost', 'db', 'postgres', 'host.docker.internal']);

export function isPrivateDatabaseHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (LOCAL_DATABASE_HOSTS.has(normalized)) {
    return true;
  }

  try {
    return ipaddr.process(normalized).range() !== 'unicast';
  } catch {
    return false;
  }
}
