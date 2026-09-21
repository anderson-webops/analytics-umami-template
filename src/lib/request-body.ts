const DEFAULT_MAX_API_BODY_BYTES = 1024 * 1024;
const MIN_API_BODY_BYTES = 16 * 1024;
const MAX_API_BODY_BYTES = 10 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the configured size limit');
    this.name = 'RequestBodyTooLargeError';
  }
}

function getMaxBodyBytes(override?: number): number {
  const value = override ?? Number(process.env.MAX_API_BODY_BYTES || DEFAULT_MAX_API_BODY_BYTES);

  if (!Number.isSafeInteger(value) || value < MIN_API_BODY_BYTES || value > MAX_API_BODY_BYTES) {
    return DEFAULT_MAX_API_BODY_BYTES;
  }

  return value;
}

export async function readRequestBodyBytes(request: Request, maxBodyBytes?: number) {
  const limit = getMaxBodyBytes(maxBodyBytes);
  const contentLength = Number(request.headers.get('content-length'));

  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > limit) {
        try {
          await reader.cancel('Request body exceeds the configured size limit');
        } catch {
          // Preserve the size error even if the source rejects cancellation.
        }

        throw new RequestBodyTooLargeError();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

export async function getJsonBody(request: Request, maxBodyBytes?: number) {
  const bytes = await readRequestBodyBytes(request, maxBodyBytes);

  try {
    const text = new TextDecoder().decode(bytes);

    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
