export function ok() {
  return Response.json({ ok: true });
}

export function json(data: Record<string, any> = {}) {
  return Response.json(data);
}

export function badRequest(error?: Record<string, any>) {
  return Response.json(
    {
      error: { message: 'Bad request', code: 'bad-request', status: 400, ...error },
    },
    { status: 400 },
  );
}

export function unauthorized(error?: Record<string, any>) {
  return Response.json(
    {
      error: {
        message: 'Unauthorized',
        code: 'unauthorized',
        status: 401,
        ...error,
      },
    },
    { status: 401 },
  );
}

export function tooManyRequests(retryAfter: number, error?: Record<string, any>) {
  return Response.json(
    {
      error: {
        message: 'Too many requests',
        code: 'too-many-requests',
        status: 429,
        ...error,
      },
    },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfter),
      },
    },
  );
}

export function forbidden(error?: Record<string, any>) {
  return Response.json(
    { error: { message: 'Forbidden', code: 'forbidden', status: 403, ...error } },
    { status: 403 },
  );
}

export function payloadTooLarge(error?: Record<string, any>) {
  return Response.json(
    {
      error: {
        message: 'Request body is too large',
        code: 'payload-too-large',
        status: 413,
        ...error,
      },
    },
    {
      status: 413,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

export function conflict(error?: Record<string, any>) {
  return Response.json(
    {
      error: {
        message: 'Conflict',
        code: 'conflict',
        status: 409,
        ...error,
      },
    },
    { status: 409 },
  );
}

export function notFound(error?: Record<string, any>) {
  return Response.json(
    { error: { message: 'Not found', code: 'not-found', status: 404, ...error } },
    { status: 404 },
  );
}

export function serviceUnavailable(error?: Record<string, any>) {
  return Response.json(
    {
      error: { message: 'Service unavailable', code: 'service-unavailable', status: 503, ...error },
    },
    { status: 503 },
  );
}

export function serverError(error?: unknown) {
  if (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const rawCode =
      typeof error === 'object' && error && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const code =
      typeof rawCode === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(rawCode) ? rawCode : undefined;

    // Messages, stacks, query text, and parameters can include credentials or
    // private analytics, so log only a bounded error classification.
    // eslint-disable-next-line no-console
    console.error('Unhandled request error', { name, ...(code ? { code } : {}) });
  }

  return Response.json(
    {
      error: {
        message: 'Server error',
        code: 'server-error',
        status: 500,
      },
    },
    {
      status: 500,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
