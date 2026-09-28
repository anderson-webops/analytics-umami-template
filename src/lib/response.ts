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

type ErrorRecord = Record<string, unknown>;

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.$:-]{1,100}$/;

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as ErrorRecord) : undefined;
}

function readProperty(record: ErrorRecord | undefined, key: string): unknown {
  if (!record) {
    return undefined;
  }

  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function safeFieldList(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return safeIdentifier(value);
  }

  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    return undefined;
  }

  const fields = value.map(safeIdentifier);

  return fields.every((field): field is string => Boolean(field)) ? fields.join(',') : undefined;
}

function getPrismaConstraint(meta: ErrorRecord | undefined): string | undefined {
  const classicTarget = safeFieldList(readProperty(meta, 'target'));

  if (classicTarget) {
    return classicTarget;
  }

  const adapter = asRecord(readProperty(meta, 'driverAdapterError'));
  const cause = asRecord(readProperty(adapter, 'cause'));
  const constraint = readProperty(cause, 'constraint');

  if (typeof constraint === 'string') {
    return safeIdentifier(constraint);
  }

  const constraintRecord = asRecord(constraint);

  return (
    safeIdentifier(readProperty(constraintRecord, 'index')) ??
    safeFieldList(readProperty(constraintRecord, 'fields'))
  );
}

export function classifyServerError(error: unknown) {
  const record = asRecord(error);
  const rawName = error instanceof Error ? error.name : readProperty(record, 'name');
  const name = safeIdentifier(rawName) ?? (error instanceof Error ? 'Error' : typeof error);
  const code = safeIdentifier(readProperty(record, 'code'));
  const diagnostics: {
    name: string;
    code?: string;
    model?: string;
    constraint?: string;
  } = { name };

  if (code) {
    diagnostics.code = code;
  }

  if (code === 'P2002') {
    const meta = asRecord(readProperty(record, 'meta'));
    const model = safeIdentifier(readProperty(meta, 'modelName'));
    const constraint = getPrismaConstraint(meta);

    if (model) {
      diagnostics.model = model;
    }

    if (constraint) {
      diagnostics.constraint = constraint;
    }
  }

  return diagnostics;
}

export function serverError(error?: unknown) {
  if (error) {
    // Messages, stacks, query text, and parameters can include credentials or
    // private analytics. Prisma P2002 model and constraint identifiers are
    // bounded schema metadata that let operators identify the conflicting
    // write without exposing request or row values.
    // eslint-disable-next-line no-console
    console.error('Unhandled request error', classifyServerError(error));
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
