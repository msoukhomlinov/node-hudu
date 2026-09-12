/**
 * Error hierarchy for the Hudu SDK.
 *
 * The structured error contract (policy §8) is additive: `code`, `status`, `url`
 * and `body` keep working exactly as before, and every error additionally carries
 * `category`, `retryable`, `httpStatus`, `vendorError`, `resourceIds`,
 * `suggestedAction`, `correlationId` and `operation` where they are known.
 */
import { isRecord } from './utils.js';

export type ErrorCategory =
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'resolution'
  | 'policy';

/** The two resolution codes. */
export type ResolutionErrorCode = 'RESOLUTION_TRUNCATED' | 'RESOLUTION_AMBIGUOUS';

export interface HuduErrorOptions {
  status?: number;
  code?: string;
  url?: string;
  body?: unknown;
  category?: ErrorCategory;
  operation?: string;
  retryable?: boolean;
  resourceIds?: number[];
  suggestedAction?: string;
  correlationId?: string;
}

/** Category implied by an HTTP status when the caller does not set one. */
function categoryForStatus(status: number | undefined, code: string): ErrorCategory {
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'not_found';
    if (status === 409 || status === 412) return 'conflict';
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'server';
    return 'validation';
  }
  switch (code) {
    case 'NETWORK_ERROR': return 'network';
    case 'TIMEOUT': return 'timeout';
    case 'RESOLUTION_TRUNCATED':
    case 'RESOLUTION_AMBIGUOUS': return 'resolution';
    case 'POLICY_DENIED': return 'policy';
    default: return 'validation';
  }
}

/** Retryability decided by the SDK, never by the vendor body. */
function retryableForStatus(status: number | undefined, category: ErrorCategory): boolean {
  if (category === 'network' || category === 'timeout') return true;
  if (status === undefined) return false;
  return status === 429 || status >= 500;
}

/** Deterministic next step for a status/category, or undefined when there is none to give. */
function suggestedActionForStatus(status: number | undefined, category: ErrorCategory): string | undefined {
  if (status !== undefined) {
    switch (status) {
      case 400: return 'Fix the request payload; see the vendor error for the offending field.';
      case 401: return 'Check the API key and its scopes.';
      case 403: return 'Check the API key scopes and the resource permissions.';
      case 404: return 'Verify the id, or resolve the record by name first.';
      case 405: return 'Check the HTTP method for this endpoint against the API spec.';
      case 406: return 'Send Accept: application/json (or text/html for redirect endpoints).';
      case 409: return 'Re-read the record and retry the change against its current state.';
      case 412: return 'Re-read the record; it changed since it was read.';
      case 422: return 'Fix the request payload; the server rejected it as semantically invalid.';
      case 429: return 'Retry after the Retry-After delay.';
      default: break;
    }
    if (status >= 500) return 'Retry the request; if it persists, check Hudu status.';
  }
  if (category === 'network') return 'Retry the request; check connectivity if it persists.';
  if (category === 'timeout') return 'Retry the request, or raise timeoutMs for a slow endpoint.';
  return undefined;
}

export class HuduError extends Error {
  readonly code: string;
  readonly url?: string;
  readonly body?: unknown;
  /** Machine-readable class of failure; drives the agent decision mapping (policy §8). */
  readonly category: ErrorCategory;
  /** True when the SDK judges the call safe to retry as-is. */
  readonly retryable: boolean;
  /** Identifiers involved (target, candidates, parent). */
  resourceIds?: number[];
  /** Deterministic next step only — never invented advice. */
  readonly suggestedAction?: string;
  /** Correlation id of the request that failed; attached by the transport. */
  correlationId?: string;
  /** Registry operation that failed; attached by the transport/resource layer. */
  operation?: string;
  private readonly _status?: number;

  constructor(message: string, options?: HuduErrorOptions) {
    super(message);
    this.name = this.constructor.name;
    this._status = options?.status;
    this.code = options?.code ?? 'HUDU_ERROR';
    this.url = options?.url;
    this.body = options?.body;
    this.category = options?.category ?? categoryForStatus(this._status, this.code);
    this.retryable = options?.retryable ?? retryableForStatus(this._status, this.category);
    this.resourceIds = options?.resourceIds;
    this.suggestedAction = options?.suggestedAction ?? suggestedActionForStatus(this._status, this.category);
    this.correlationId = options?.correlationId;
    this.operation = options?.operation;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** HTTP status when there was one. @deprecated use `httpStatus` (kept as an alias). */
  get status(): number | undefined {
    return this._status;
  }

  /** Canonical HTTP status field (policy §8). */
  get httpStatus(): number | undefined {
    return this._status;
  }

  /** The raw vendor payload, preserved under a documented key (alias of `body`). */
  get vendorError(): unknown {
    return this.body;
  }
}

export class HuduConfigError extends HuduError {
  constructor(message: string) {
    super(message, {
      code: 'CONFIG_ERROR',
      category: 'validation',
      retryable: false,
      suggestedAction: 'Fix the client configuration; the message names the invalid option.',
    });
  }
}

export class HuduNetworkError extends HuduError {
  constructor(message: string, url?: string, options?: { category?: ErrorCategory; retryable?: boolean }) {
    // Category/retryability derive from the NETWORK_ERROR code (network, retryable);
    // a deadline abort passes { category: 'timeout' } instead.
    super(message, { code: 'NETWORK_ERROR', url, ...options });
  }
}

export class BadRequestError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 400, code: 'BAD_REQUEST', url, body });
  }
}
export class UnauthorizedError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 401, code: 'UNAUTHORIZED', url, body });
  }
}
export class ForbiddenError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 403, code: 'FORBIDDEN', url, body });
  }
}
export class NotFoundError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 404, code: 'NOT_FOUND', url, body });
  }
}
export class MethodNotAllowedError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 405, code: 'METHOD_NOT_ALLOWED', url, body });
  }
}
export class NotAcceptableError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 406, code: 'NOT_ACCEPTABLE', url, body });
  }
}
export class UnprocessableEntityError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 422, code: 'UNPROCESSABLE_ENTITY', url, body });
  }
}
export class RateLimitError extends HuduError {
  readonly retryAfter?: number;
  constructor(message: string, url?: string, body?: unknown, retryAfter?: number, options?: HuduErrorOptions) {
    super(message, { ...options, status: 429, code: 'RATE_LIMIT', url, body });
    this.retryAfter = retryAfter;
  }
}
export class ServerError extends HuduError {
  constructor(message: string, status: number, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status, code: 'SERVER_ERROR', url, body });
  }
}

/** 409 — the record conflicts with its current server state. */
export class ConflictError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 409, code: 'CONFLICT', category: 'conflict', retryable: false, url, body });
  }
}

/** 412 — the record changed since the caller read it. Never retryable as-is. */
export class StaleObjectError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 412, code: 'STALE_OBJECT', category: 'conflict', retryable: false, url, body });
  }
}

/** 400 — the payload is structurally valid but semantically rejected. */
export class ValidationFailedError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, { ...options, status: 400, code: 'VALIDATION_FAILED', category: 'validation', retryable: false, url, body });
  }
}

/** A duplicate exists; `resourceIds` carries the existing record's id. */
export class DuplicateFoundError extends HuduError {
  constructor(message: string, url?: string, body?: unknown, options?: HuduErrorOptions) {
    super(message, {
      ...options,
      code: 'DUPLICATE_FOUND',
      category: 'conflict',
      retryable: false,
      url,
      body,
      suggestedAction: options?.suggestedAction ?? 'Use the existing record id from resourceIds instead of creating another.',
    });
  }
}

/** A bounded scan could not decide, or an identifier was ambiguous (policy §6). */
export class ResolutionError extends HuduError {
  constructor(message: string, code: ResolutionErrorCode, options?: HuduErrorOptions) {
    super(message, {
      ...options,
      code,
      retryable: false,
      suggestedAction:
        options?.suggestedAction ??
        (code === 'RESOLUTION_TRUNCATED'
          ? 'Raise resolution.maxScanRecords/maxScanPages, or resolve by { id } or a server-side filter.'
          : 'Pass { id } or an exact server-side filter, or choose one of the candidate ids in resourceIds.'),
    });
  }

  /** The scan hit its cap before the data ran out. Returning null here would be a lie. */
  static truncated(message: string, options?: HuduErrorOptions): ResolutionError {
    return new ResolutionError(message, 'RESOLUTION_TRUNCATED', options);
  }

  /** Several records matched, and the vendor filter cannot disambiguate them. */
  static ambiguous(message: string, options?: HuduErrorOptions): ResolutionError {
    return new ResolutionError(message, 'RESOLUTION_AMBIGUOUS', options);
  }
}

/** The SDK refused a mutation by policy (e.g. an unbounded bulk delete without confirmation). */
export class PolicyDeniedError extends HuduError {
  constructor(message: string, options?: HuduErrorOptions) {
    super(message, {
      ...options,
      code: 'POLICY_DENIED',
      retryable: false,
      suggestedAction: options?.suggestedAction ?? 'Bound the operation with explicit ids, or run it with { dryRun: true } first.',
    });
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
    case 409: return new ConflictError(message, url, body);
    case 412: return new StaleObjectError(message, url, body);
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
    405: 'Method Not Allowed', 406: 'Not Acceptable', 409: 'Conflict',
    412: 'Precondition Failed', 422: 'Unprocessable Entity',
    429: 'Rate Limited',
  };
  return map[status] ?? `Hudu API error (HTTP ${status})`;
}

export function isHuduError(err: unknown): err is HuduError {
  return err instanceof HuduError;
}
