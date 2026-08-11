/**
 * Error hierarchy for the Hudu SDK.
 */
import { isRecord } from './utils.js';
export class HuduError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly url?: string;
  readonly body?: unknown;

  constructor(message: string, options?: { status?: number; code?: string; url?: string; body?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    this.status = options?.status;
    this.code = options?.code ?? 'HUDU_ERROR';
    this.url = options?.url;
    this.body = options?.body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HuduConfigError extends HuduError {
  constructor(message: string) {
    super(message, { code: 'CONFIG_ERROR' });
  }
}

export class HuduNetworkError extends HuduError {
  constructor(message: string, url?: string) {
    super(message, { code: 'NETWORK_ERROR', url });
  }
}

export class BadRequestError extends HuduError {
  constructor(message: string, url?: string, body?: unknown) {
    super(message, { status: 400, code: 'BAD_REQUEST', url, body });
  }
}
export class UnauthorizedError extends HuduError {
  constructor(message: string, url?: string, body?: unknown) {
    super(message, { status: 401, code: 'UNAUTHORIZED', url, body });
  }
}
export class ForbiddenError extends HuduError {
  constructor(message: string, url?: string, body?: unknown) {
    super(message, { status: 403, code: 'FORBIDDEN', url, body });
  }
}
export class NotFoundError extends HuduError {
  constructor(message: string, url?: string, body?: unknown) {
    super(message, { status: 404, code: 'NOT_FOUND', url, body });
  }
}
export class MethodNotAllowedError extends HuduError {
  constructor(message: string, url?: string, body?: unknown) {
    super(message, { status: 405, code: 'METHOD_NOT_ALLOWED', url, body });
  }
}
export class NotAcceptableError extends HuduError {
  constructor(message: string, url?: string, body?: unknown) {
    super(message, { status: 406, code: 'NOT_ACCEPTABLE', url, body });
  }
}
export class UnprocessableEntityError extends HuduError {
  constructor(message: string, url?: string, body?: unknown) {
    super(message, { status: 422, code: 'UNPROCESSABLE_ENTITY', url, body });
  }
}
export class RateLimitError extends HuduError {
  readonly retryAfter?: number;
  constructor(message: string, url?: string, body?: unknown, retryAfter?: number) {
    super(message, { status: 429, code: 'RATE_LIMIT', url, body });
    this.retryAfter = retryAfter;
  }
}
export class ServerError extends HuduError {
  constructor(message: string, status: number, url?: string, body?: unknown) {
    super(message, { status, code: 'SERVER_ERROR', url, body });
  }
}

/**
 * Map an HTTP status code to the corresponding HuduError subclass.
 */
export function errorFromStatus(status: number, body: unknown, url?: string): HuduError {
  const message = errorMessage(body, status);
  switch (status) {
    case 400: return new BadRequestError(message, url, body);
    case 401: return new UnauthorizedError(message, url, body);
    case 403: return new ForbiddenError(message, url, body);
    case 404: return new NotFoundError(message, url, body);
    case 405: return new MethodNotAllowedError(message, url, body);
    case 406: return new NotAcceptableError(message, url, body);
    case 422: return new UnprocessableEntityError(message, url, body);
    case 429: return new RateLimitError(message, url, body);
    default:
      if (status >= 500) return new ServerError(message, status, url, body);
      return new HuduError(message, { status, code: `HTTP_${status}`, url, body });
  }
}

/** Best-effort message for an error: a string body verbatim, else body.message ??
 * body.error when the body is a record, else a status-derived fallback (B13).
 * The JSON detail otherwise only reached err.body — this surfaces it in err.message. */
function errorMessage(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim().length > 0) return body;
  if (isRecord(body)) {
    const detail = body.message ?? body.error;
    if (typeof detail === 'string' && detail.trim().length > 0) return detail;
  }
  return statusText(status);
}

function statusText(status: number): string {
  const map: Record<number, string> = {
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 406: 'Not Acceptable', 422: 'Unprocessable Entity',
    429: 'Rate Limited',
  };
  return map[status] ?? `Hudu API error (HTTP ${status})`;
}

export function isHuduError(err: unknown): err is HuduError {
  return err instanceof HuduError;
}
