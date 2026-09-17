/**
 * Error hierarchy for the Hudu SDK.
 *
 * The structured error contract (policy §8) is additive: `code`, `status`, `url`
 * and `body` keep working exactly as before, and every error additionally carries
 * `category`, `retryable`, `httpStatus`, `vendorError`, `resourceIds`,
 * `suggestedAction`, `correlationId` and `operation` where they are known.
 */
import { isRecord } from './utils.js';
import type { ArticleHtmlFinding } from './resources/article-html.js';

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

/**
 * One vendor field rejection, normalized into a machine-readable pair.
 *
 * `field` is the vendor's own field name when the body names one, or the
 * `UNKNOWN_FIELD` sentinel for a body-level problem that names no field.
 * `message` is the vendor text verbatim (trimmed).
 */
export interface FieldError {
  field: string;
  message: string;
}

/**
 * Sentinel `field` used for a validation problem the vendor did not attribute to a
 * named field (e.g. `{"errors": "Network does not belong to the specified company"}`).
 * A caller that wants field-attributed problems only can drop entries whose
 * `field` is `UNKNOWN_FIELD`.
 */
export const UNKNOWN_FIELD = '*';

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
  /** Pre-parsed field rejections; when omitted, the validation errors parse the body. */
  fieldErrors?: FieldError[];
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

/** Longest token still treated as a field name rather than prose. */
const MAX_FIELD_NAME = 64;
/** A plausible field name: identifier-ish, optionally with dotted/bracketed nesting. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.\-[\]]*$/;

/** Trim a vendor string into a usable message, or undefined when it carries nothing. */
function cleanMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The field a prose clause names, when its trailing token after the last ': ' looks like a field. */
function fieldFromProse(text: string): string | undefined {
  const at = text.lastIndexOf(': ');
  if (at === -1) return undefined;
  const token = text.slice(at + 2).trim();
  if (token.length === 0 || token.length > MAX_FIELD_NAME) return undefined;
  return FIELD_NAME.test(token) ? token : undefined;
}

/** Flatten a Rails-style field -> string | string[] map into one entry per message. */
function entriesFromMap(map: Record<string, unknown>): FieldError[] {
  const out: FieldError[] = [];
  for (const [field, value] of Object.entries(map)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      const message = cleanMessage(item);
      if (message !== undefined) out.push({ field, message });
    }
  }
  return out;
}

/**
 * Normalize the field-level detail a vendor error body carries, so an agent can tell
 * WHICH field was rejected without parsing the raw payload itself.
 *
 * Recognized shapes, in priority order:
 * - a map of field -> string | string[] (Rails style), e.g.
 *   `{"errors": {"name": ["can't be blank"], "address": "is invalid"}}`
 * - a top-level `errors` string or array of strings, e.g.
 *   `{"errors": "Network does not belong to the specified company"}`; the vendor names
 *   no field, so those entries carry the documented `UNKNOWN_FIELD` sentinel
 * - a `details` prose string whose trailing clause names a field, e.g.
 *   `{"error": "Parameter missing", "details": "param is missing or the value is empty: company"}`
 *   -> field `company`; a prose tail that does not look like a field yields `UNKNOWN_FIELD`
 *
 * Any other body (a string, null, an array at the root, a map without usable messages)
 * yields `undefined`. This function never throws and never serializes the body, so a
 * malformed or circular body cannot mask the original error.
 *
 * Pure: exported for direct unit testing.
 */
export function parseFieldErrors(body: unknown): FieldError[] | undefined {
  try {
    if (!isRecord(body)) return undefined;
    const { errors, details } = body;
    if (isRecord(errors)) {
      const mapped = entriesFromMap(errors);
      if (mapped.length > 0) return mapped;
    } else if (Array.isArray(errors)) {
      const listed: FieldError[] = [];
      for (const item of errors) {
        const message = cleanMessage(item);
        if (message !== undefined) listed.push({ field: UNKNOWN_FIELD, message });
      }
      if (listed.length > 0) return listed;
    } else {
      const single = cleanMessage(errors);
      if (single !== undefined) return [{ field: UNKNOWN_FIELD, message: single }];
    }
    const prose = cleanMessage(details);
    if (prose !== undefined) return [{ field: fieldFromProse(prose) ?? UNKNOWN_FIELD, message: prose }];
    return undefined;
  } catch {
    // A malformed body must never mask the original error.
    return undefined;
  }
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
  /**
   * Normalized field-level rejections when the vendor body carried them.
   *
   * Populated on the validation-shaped errors (`BadRequestError` 400,
   * `UnprocessableEntityError` 422, `ValidationFailedError`) from the raw body via
   * `parseFieldErrors`; `undefined` for every other error class and for a body with no
   * recognizable field detail. Additive: `message`, `code`, `status`, `body` and
   * `vendorError` are unaffected. Entries whose `field` is `UNKNOWN_FIELD` (`'*'`)
   * describe a body-level problem that names no field.
   */
  readonly fieldErrors?: FieldError[];
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
    this.fieldErrors = options?.fieldErrors;
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
  constructor(message: string, options?: HuduErrorOptions) {
    super(message, {
      ...options,
      code: 'CONFIG_ERROR',
      category: 'validation',
      retryable: false,
      suggestedAction: options?.suggestedAction ?? 'Fix the client configuration; the message names the invalid option.',
    });
  }
}

/**
 * A credential could not be resolved for a request (issue #23). Fail closed: no request was sent.
 * Distinct from `UnauthorizedError` (the server rejected a credential that WAS sent).
 */
export class AuthError extends HuduError {
  constructor(message: string, options?: HuduErrorOptions) {
    super(message, {
      ...options,
      code: 'AUTH_ERROR',
      // Explicit: categoryForStatus() defaults a status-less code to 'validation'.
      category: 'auth',
      retryable: false,
      suggestedAction:
        options?.suggestedAction ??
        'Fix the auth strategy: headers(ctx) must return at least one non-empty header.',
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
    super(message, {
      ...options, status: 400, code: 'BAD_REQUEST', url, body,
      fieldErrors: options?.fieldErrors ?? parseFieldErrors(body),
    });
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
    super(message, {
      ...options, status: 422, code: 'UNPROCESSABLE_ENTITY', url, body,
      fieldErrors: options?.fieldErrors ?? parseFieldErrors(body),
    });
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
    super(message, {
      ...options, status: 400, code: 'VALIDATION_FAILED', category: 'validation', retryable: false, url, body,
      fieldErrors: options?.fieldErrors ?? parseFieldErrors(body),
    });
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
 * A Markdown write would have destroyed content in the STORED article.
 *
 * Thrown by `articles.update` when the current body does not survive an HTML -> Markdown
 * -> HTML round trip. The question it answers is "does what is already there survive",
 * which is why it catches destruction of regions the caller never edited.
 *
 * Presentation-impact findings never cause this throw; they are carried in `findings` so
 * a caller can report them.
 */
export class HuduContentLossError extends HuduError {
  readonly code = 'CONTENT_LOSS';
  readonly findings: readonly ArticleHtmlFinding[];

  constructor(operation: string, findings: readonly ArticleHtmlFinding[]) {
    const lost = findings.filter((f) => f.impact === 'content');
    super(
      `${operation}: this article cannot be edited as Markdown without losing content. ` +
        lost.map((f) => `${f.code} (${f.element}): ${f.message}`).join(' ') +
        ' Send the update as HTML to keep everything, or pass allowLossyMarkdown: true to accept the loss.',
      {
        operation,
        suggestedAction:
          'Send the update as HTML, or pass { allowLossyMarkdown: true } having read the findings on this error.',
      },
    );
    this.findings = findings;
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
