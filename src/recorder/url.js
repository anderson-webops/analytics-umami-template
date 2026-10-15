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

export function isUrlBearingReplayAttribute(value) {
  return (
    typeof value === 'string' &&
    /(?:https?:\/\/|(?:^|\s)\/[^\s]+|\?[^\s=]+=[^\s]+|%3a%2f%2f|%3f[^\s]*%3d)/i.test(value)
  );
}

export function redactReplayNavigationEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (event.type === 4) {
    const { href, width, height } = event.data || {};
    return {
      type: 4,
      timestamp: event.timestamp,
      data: {
        ...(typeof href === 'string' && { href: getReplaySafeUrl(href) }),
        ...(Number.isFinite(width) && { width }),
        ...(Number.isFinite(height) && { height }),
      },
    };
  }

  if (event.type === 5) {
    const payload = event.data?.payload;

    if (event.data?.tag === 'url-change' && typeof payload?.url === 'string') {
      return {
        type: 5,
        timestamp: event.timestamp,
        data: { tag: 'url-change', payload: { url: getReplaySafeUrl(payload.url) } },
      };
    }

    if (event.data?.tag === 'scroll-progress' && payload && typeof payload === 'object') {
      const safePayload = {};
      for (const key of ['scrollPct', 'pageW', 'pageH', 'viewportW', 'viewportH']) {
        if (Number.isFinite(payload[key]) && payload[key] >= 0 && payload[key] <= 10_000_000) {
          safePayload[key] = payload[key];
        }
      }
      if (typeof payload.url === 'string') safePayload.url = getReplaySafeUrl(payload.url);
      return {
        type: 5,
        timestamp: event.timestamp,
        data: { tag: 'scroll-progress', payload: safePayload },
      };
    }

    return null;
  }

  return event;
}

export function redactReplayNavigationEvents(events) {
  return events.map(redactReplayNavigationEvent).filter(Boolean);
}
