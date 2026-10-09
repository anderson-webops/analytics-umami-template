export function getReplaySafeUrl(value) {
  if (typeof value !== 'string' || (!value.startsWith('/') && !/^https?:\/\//i.test(value))) {
    return '/';
  }

  try {
    const url = new URL(value, 'https://replay.invalid');

    if (!['http:', 'https:'].includes(url.protocol) || value.startsWith('//')) {
      return '/';
    }

    return value.startsWith('/') ? url.pathname : `${url.origin}${url.pathname}`;
  } catch {
    return '/';
  }
}

export function redactReplayNavigationEvent(event) {
  if (!event || typeof event !== 'object') {
    return event;
  }

  if (event.type === 4 && typeof event.data?.href === 'string') {
    return { ...event, data: { ...event.data, href: getReplaySafeUrl(event.data.href) } };
  }

  if (event.type === 5 && event.data?.tag === 'url-change') {
    const payload = event.data.payload;

    if (typeof payload?.url === 'string') {
      return {
        ...event,
        data: {
          ...event.data,
          payload: { ...payload, url: getReplaySafeUrl(payload.url) },
        },
      };
    }
  }

  return event;
}

export function redactReplayNavigationEvents(events) {
  return events.map(redactReplayNavigationEvent);
}
