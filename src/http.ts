/**
 * HTTP transport using native fetch (Node >= 18). Zero runtime dependencies.
 */
import { randomUUID } from 'node:crypto';
import { isAuthStrategy } from './auth.js';
import type { AuthContext, AuthHeaders, AuthStrategy } from './auth.js';
import type { ResolutionConfig, ResolvedConfig } from './config.js';
import { AuthError, errorFromStatus, HuduError, HuduNetworkError, RateLimitError } from './errors.js';
import { redact } from './logger.js';
import type { AuditEvent, OperationEffect, OperationImpact } from './types/common.js';
import { isRecord, isThenable } from './utils.js';

/** Hard cap on any single retry/backoff sleep (B6). */
const MAX_RETRY_DELAY_MS = 30_000;

/** Every abort caused by the whole-call deadline is a timeout, and timeouts are retryable (policy §10). */
const TIMEOUT = { category: 'timeout', retryable: true } as const;

/** Native `fetch()` message shape when `Headers` refuses a name or a value (echoes the value). */
const INVALID_HEADER_PATTERN = /invalid header (name|value)/i;

/** Reject with `onTimeout()` when `pending` has not settled within `ms`. Clears its own timer. */
function withDeadline<T>(pending: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), Math.max(ms, 0));
    pending.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** RFC 7230 `tchar` (1*): every character legal in an HTTP field name. Anything else is a separator. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * True when `value` holds any character outside printable ASCII (0x20-0x7E). Two failure modes are
 * covered at once. An interior CR/LF survives a `.trim()`, and native `fetch()` refuses such a value
 * by throwing a `TypeError` whose message ECHOES the raw value — for a credential header, that is
 * the credential in an error string. A code unit above 0xFF (a Latin-1 or emoji character) makes the
 * `Headers` constructor throw a `ByteString` `TypeError`, which is a failure this SDK must own
 * rather than surface as an engine error.
 */
function hasNonPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return true;
  }
  return false;
}

/**
 * Names a plain-object write would NOT create as an own key: `out['__proto__'] = value` sets the
 * prototype, so a map whose only key was `__proto__` used to come back EMPTY and the request went
 * out with no credential at all.
 */
const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A strategy's map must be a non-empty plain record of non-empty strings whose names are legal HTTP
 * field names, are not one of `FORBIDDEN_HEADER_NAMES`, and whose values are printable-ASCII HTTP
 * field values — anything else is fail-closed. The result is accumulated on a null-prototype object,
 * where every accepted name becomes an own key, so the returned map always carries a credential.
 */
function validateAuthHeaders(name: string, ctx: AuthContext, produced: unknown): AuthHeaders {
  if (!isRecord(produced) || Object.keys(produced).length === 0) throw authFailureError(name, ctx);
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(produced)) {
    if (FORBIDDEN_HEADER_NAMES.has(key)) throw authFailureError(name, ctx);
    if (typeof value !== 'string' || value.trim().length === 0) throw authFailureError(name, ctx);
    if (!HEADER_NAME_PATTERN.test(key) || hasNonPrintableAscii(value)) throw authFailureError(name, ctx);
    out[key] = value;
  }
  return out;
}

/** Fixed message shapes: strategy name, method, path, attempt. Never a header value, never a cause. */
function authFailureError(name: string, ctx: AuthContext): AuthError {
  return new AuthError(
    `Auth strategy "${name}" did not produce usable credential headers for ${ctx.method} ${ctx.path} ` +
    `(attempt ${ctx.attempt + 1}); no request was sent`,
  );
}

/**
 * Fixed message for a config whose resolved credential is not a usable strategy (e.g. a hand-built
 * `ResolvedConfig` without `auth`). Fail closed with `AuthError` — never a raw `TypeError`, and no
 * request on the wire.
 */
function missingAuthStrategyError(): AuthError {
  return new AuthError('no auth strategy is configured', {
    suggestedAction: 'Pass apiKey or auth to resolveConfig, or a strategy via withAuth().',
  });
}

function authTimeoutError(name: string, ctx: AuthContext, remaining: number): AuthError {
  return new AuthError(
    `Auth strategy "${name}" did not resolve within the remaining request budget (${Math.max(remaining, 0)}ms) ` +
    `for ${ctx.method} ${ctx.path}; timeoutMs bounds the whole call, retries and this wait included`,
    { suggestedAction: 'Raise timeoutMs or make headers(ctx) resolve faster; no request was sent.' },
  );
}

/**
 * Merge in the documented order: strategy headers < caller `headers` < `Accept` < `Content-Type`.
 * Header names are case-insensitive, so a case-colliding pair (strategy `authorization`, caller
 * `Authorization`) collapses to one entry — the later writer wins and keeps its own spelling.
 * This reproduces today's observable behaviour exactly for an `x-api-key` client.
 */
function mergeRequestHeaders(
  credentialHeaders: AuthHeaders,
  callerHeaders: Record<string, string> | undefined,
  accept: string | undefined,
  opts: RequestOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  const index = new Map<string, string>();

  const put = (key: string, value: string): void => {
    const name = key.toLowerCase();
    const previous = index.get(name);
    if (previous !== undefined && previous !== key) delete out[previous];
    index.set(name, key);
    out[key] = value;
  };

  for (const [key, value] of Object.entries(credentialHeaders)) put(key, value);
  for (const [key, value] of Object.entries(callerHeaders ?? {})) put(key, value);
  // Unchanged today: `Accept` is set last, so an explicit `opts.accept` (or the JSON default) wins
  // over a caller `headers.Accept`. Deliberately preserved, and pinned by a test.
  put('Accept', accept ?? 'application/json');
  if (opts.formUrlEncoded) put('Content-Type', 'application/x-www-form-urlencoded');
  else if (opts.body !== undefined && !opts.formData) put('Content-Type', 'application/json');
  return out;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path after basePath, e.g. '/companies/{id}' (already interpolated). */
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  formData?: FormData;
  /** application/x-www-form-urlencoded form fields (e.g. some DELETE endpoints per spec). */
  formUrlEncoded?: Record<string, string | number>;
  headers?: Record<string, string>;
  /** Override Accept header (e.g. 'text/html' for redirect endpoints). */
  accept?: string;
  /** Default true. POST is never retried; set false to opt out of retries for others. */
  retries?: boolean;
  /**
   * Response handling. Default 'json' (JSON.parse, falling back to raw text).
   * 'blob' returns the response body as a real Blob (binary). Use for downloads.
   */
  responseType?: 'json' | 'blob';
  /**
   * Use browser-style `redirect: 'manual'` and resolve the 3xx Location header
   * into an absolute URL. Used by redirect endpoints (e.g. /companies/jump).
   */
  manualRedirect?: boolean;
  /** Registry-style operation name (e.g. 'companies.create'); used for audit events and errors. */
  operation?: string;
  /** Target resource ids; used for audit events and structured errors. Derived from numeric path segments when absent. */
  resourceIds?: number[];
  /**
   * Describe the call instead of performing it. The transport does NOT call fetch;
   * it returns a `DryRunRequest` marker and audits the event with `dryRun: true`.
   */
  dryRun?: boolean;
  /**
   * Impact statement for a mutation, carried into the audit event as the executed-result
   * metadata (policy §7.3). Defaults to a single-record change whose reversibility follows
   * the HTTP verb. Bulk callers pass `{ affected, scope: 'bulk', exact: false }` when the
   * server computes the real target set.
   */
  impact?: OperationImpact;
  /**
   * Per-request credential override. Defaults to the client's own strategy (`config.auth`).
   * Exposed so a caller that drives `HttpClient` directly — or that wants one endpoint
   * authenticated differently — can hand in a resolved credential, and so `download()` /
   * `resolveRedirect()` carry it automatically (`Omit<RequestOptions, 'responseType'>`).
   *
   * The scoped-client design (section 4) does NOT need this: resources never set `headers` or `auth`,
   * so no public method signature changes.
   */
  auth?: AuthStrategy;
}

/** Marker returned instead of a server response when `{ dryRun: true }` short-circuits the transport. */
export interface DryRunRequest {
  readonly __dryRun: true;
  readonly simulated: true;
  readonly method: string;
  readonly path: string;
  readonly url: string;
}

/** Audit effect for an HTTP verb (policy §7.1). */
function effectForMethod(method: string): OperationEffect {
  if (method === 'GET') return 'read';
  if (method === 'DELETE') return 'destructive';
  return 'write';
}

/**
 * Best-effort impact for a single-record mutation when the caller supplies none
 * (policy §7.3): a write is reversible, a destructive call is not.
 */
function defaultImpactFor(effect: OperationEffect): OperationImpact {
  return { affected: 1, scope: 'single', reversible: effect !== 'destructive' };
}

/** Numeric path segments, used as the resource ids when the caller does not name them. */
function deriveResourceIds(path: string): number[] | undefined {
  const ids: number[] = [];
  for (const segment of path.split('/')) {
    if (/^\d+$/.test(segment)) ids.push(Number(segment));
  }
  return ids.length > 0 ? ids : undefined;
}

function resourceIdsFor(opts: RequestOptions): number[] | undefined {
  return opts.resourceIds ?? deriveResourceIds(opts.path);
}

/** Fallback operation name when a raw transport caller does not pass one. */
function deriveOperation(method: string, path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const named = segments.filter((segment) => !/^\d+$/.test(segment));
  const resource = named[0] ?? 'hudu';
  const hasId = named.length !== segments.length;
  const last = segments[segments.length - 1] ?? '';
  if (named.length > 1 && !/^\d+$/.test(last)) return `${resource}.${last}`;
  if (method === 'GET') return hasId ? `${resource}.get` : `${resource}.list`;
  if (method === 'POST') return `${resource}.create`;
  if (method === 'PUT') return `${resource}.update`;
  return `${resource}.delete`;
}

/**
 * Parse a Retry-After header into a delay in seconds.
 *
 * RFC 7231 allows BOTH forms:
 * - `delta-seconds`: an integer (or, leniently, any numeric string the previous
 *   implementation accepted — fractional values are common in practice);
 * - `HTTP-date`: e.g. "Wed, 21 Oct 2015 07:28:00 GMT", for which the delay is the
 *   distance from now, CLAMPED AT 0 (a date already in the past means "retry now").
 *
 * Returns undefined when the header is absent or matches neither form, so the
 * caller falls back to the exponential backoff exactly as before. This also fixes
 * a real timing bug: an HTTP-date used to become NaN, read as "no hint", and a
 * backoff SHORTER than the server asked for could retry too early.
 *
 * `now` exists for deterministic tests; production callers omit it.
 */
function retryAfterSeconds(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  // Numeric form first, on the raw header: preserves the existing delta-seconds
  // behaviour (including fractional and whitespace-padded values) byte for byte.
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  // HTTP-date form. Date.parse tolerates the leading/trailing whitespace and the
  // obsolete RFC 850 / asctime shapes the HTTP grammar still permits.
  const when = Date.parse(header);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, (when - now) / 1000);
}

/**
 * Compute the delay before a retry: exponential backoff (or a Retry-After hint),
 * capped at MAX_RETRY_DELAY_MS with a small jitter (up to ~25% of this delay) so
 * co-retried clients don't synchronise (B6).
 */
function retryDelayMs(attempt: number, retryAfterSeconds?: number): number {
  const base = Math.max(
    retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : 200 * (2 ** attempt),
    0,
  );
  // Jitter is a fraction of the un-capped base, and the SUM (base + jitter) is
  // then capped, so the total never exceeds MAX_RETRY_DELAY_MS (F6).
  const jitter = Math.floor(Math.random() * (base * 0.25 + 1));
  return Math.min(MAX_RETRY_DELAY_MS, base + jitter);
}

/**
 * If data is an object with `key`, returns data[key]; otherwise returns data
 * (ARCHITECTURE.md §envelope). A non-record (including `undefined` from a 204/empty
 * body) is passed through rather than fabricated into `{}` (B3) — the caller can
 * then surface the mismatch instead of silently seeing an empty object.
 */
export function unwrapByKey<T>(data: unknown, key?: string): T {
  if (isRecord(data) && key && key in data) return data[key] as T;
  return data as T;
}

/**
 * For list responses: expects `data[key]` to be an array and returns it. When
 * the response already is an array, passes it through. When a `key` is expected
 * but the envelope is missing or malformed, throws instead of silently yielding
 * an empty list forever (B4) — a wrong listKey must not surface as "no results".
 */
export function unwrapList<T>(data: unknown, key?: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (key !== undefined) {
    // A list endpoint may legitimately return an empty/null body or a null
    // envelope value when there are no results. Surface those as an empty list
    // rather than throwing (F3).
    if (data === undefined || data === null) return [];
    if (isRecord(data)) {
      // Envelope key present but null/undefined => empty list (F3).
      if (key in data) {
        const value = data[key];
        if (value === undefined || value === null) return [];
        if (Array.isArray(value)) return value as T[];
      }
      // Key absent: if the record is empty (e.g. a bare `{}` zero-result body
      // from a live API that omits the envelope), treat it as an empty list
      // rather than throwing. Only a NON-EMPTY record missing the key (or a
      // non-array value at the key) is a genuine shape error.
      if (Object.keys(data).length === 0) return [];
      // Key absent from a non-empty record, or present with a non-array,
      // non-null value: a genuine shape error — a wrong listKey must not
      // surface as no results.
      throw new HuduError(
        `List response missing expected envelope key "${key}" (got a non-array${isRecord(data) ? ' record' : ''}). ` +
          'Check the resource listKey against the API spec.',
        { code: 'ENVELOPE_ERROR' },
      );
    }
    // A scalar (non-record) with a key is a genuine shape error.
    throw new HuduError(
      `List response missing expected envelope key "${key}" (got a non-array scalar). ` +
        'Check the resource listKey against the API spec.',
      { code: 'ENVELOPE_ERROR' },
    );
  }
  // No key: the body itself is expected to be an array; pass through unchanged.
  return data as T[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a body-consumption await (response.blob()/response.text()) so failures
 * while TRANSFERRING the response body surface as a HuduNetworkError matching
 * the fetch-timeout contract:
 * - An abort or timeout fired by the deadline's AbortSignal — headers already
 *   received but the body stalling — maps to the timeout message (code
 *   NETWORK_ERROR), consistent with the fetch timeout path.
 * - Any OTHER body-transfer failure is also a transport failure: e.g. the
 *   server/proxy dropped the connection mid-body (Node's blob()/text() rejects
 *   with a TypeError such as "terminated"), or a non-Error rejection (a thrown
 *   string). These are wrapped in a HuduNetworkError with a distinct network
 *   message (code NETWORK_ERROR) rather than leaking a raw untyped error that
 *   a consumer checking HuduError.code cannot handle consistently.
 * Consuming the response body has no deliberate application-level errors of
 * its own, so every rejection here (Error or otherwise) is treated as a
 * transport error and wrapped.
 */
function catchBodyError(err: unknown, method: string, url: string, timeoutMs: number): never {
  const safe = pathOnlyUrl(url);
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    throw new HuduNetworkError(`Request timed out after ${timeoutMs}ms: ${method} ${safe}`, safe, TIMEOUT);
  }
  const detail = err instanceof Error ? err.message : String(err);
  throw new HuduNetworkError(`Network error while reading response body: ${detail}`, safe);
}

/**
 * The URL form that may reach a CALLER-VISIBLE error surface: scheme + host + path, never the query
 * string. A query string carries the caller's own data (search terms, asset filters, identifiers),
 * and an error message or `HuduError.url` is exactly the kind of value that lands in a log, an agent
 * transcript or a bug report. The transport's debug line (C14) is path-only for the same reason;
 * this extends that rule to every error this module raises.
 */
function pathOnlyUrl(url: string): string {
  const query = url.indexOf('?');
  if (query >= 0) return url.slice(0, query);
  const hash = url.indexOf('#');
  return hash >= 0 ? url.slice(0, hash) : url;
}

export interface TokenBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
}

/** Mutable limiter/queue state. Shared by a client and every client it scopes (issue #23). */
export interface TransportState {
  bucket?: TokenBucket;
  consumeTail: Promise<void>;
  queued: number;
  inFlight: number;
  lastRetryAfterSeconds?: number;
}

/** A fresh state for one client tree. */
export function newTransportState(config: ResolvedConfig): TransportState {
  return {
    bucket: config.rateLimit
      ? {
          tokens: config.rateLimit.burst,
          lastRefill: Date.now(),
          capacity: config.rateLimit.burst,
          refillPerMs: config.rateLimit.perMinute / 60000,
        }
      : undefined,
    consumeTail: Promise.resolve(),
    queued: 0,
    inFlight: 0,
  };
}

/**
 * Read-only snapshot of the transport's LOCAL limiter/queue state, for callers
 * that need to apply backpressure of their own (e.g. an MCP tool layer deciding
 * whether to enqueue more work). Every field is measured from state the transport
 * really keeps — nothing here is estimated for effect.
 */
export interface RateLimitStatus {
  /** True when a client-side token bucket is configured (`rateLimit`). */
  readonly enabled: boolean;
  /** True only when `enabled` and no whole token is available right now. */
  readonly throttled: boolean;
  /**
   * Estimated tokens available right now, with the bucket refill applied at read
   * time (may be fractional). 0 when `enabled` is false.
   */
  readonly availableTokens: number;
  /** Bucket capacity in tokens, i.e. the configured burst. 0 when `enabled` is false. */
  readonly burst: number;
  /** Callers waiting for a limiter token. Always 0 when `enabled` is false. */
  readonly queued: number;
  /** Requests in progress in the transport, retries and their backoff sleeps included. */
  readonly inFlight: number;
  /** The last `Retry-After` hint the transport actually waited for, in seconds. */
  readonly lastRetryAfterSeconds?: number;
}

export class HttpClient {
  private readonly config: ResolvedConfig;
  /** One limiter/queue state per client tree: `withAuth()` shares it, so scopes never double their rate budget. */
  readonly state: TransportState;
  /** Client-scan caps shared with BaseResource.boundedScan (policy §6). */
  readonly resolution: Required<ResolutionConfig>;
  /** Bounded parallelism for bulk helpers (policy §10). */
  readonly concurrency: number;

  constructor(config: ResolvedConfig, state?: TransportState) {
    this.config = config;
    this.state = state ?? newTransportState(config);
    this.resolution = config.resolution;
    this.concurrency = config.concurrency;
  }

  /**
   * Issue one request through the single transport.
   *
   * - One correlation id per call, generated BEFORE the first attempt and reused
   *   across retries; it is attached to every thrown HuduError and to the audit event.
   * - Calls `config.onAudit` once per call (success or error path) with a redacted event.
   *   Nothing is logged by default.
   * - With `{ dryRun: true }` it never calls fetch: it returns a `DryRunRequest` marker
   *   and fires the audit event with `dryRun: true`.
   */
  async request<T>(opts: RequestOptions): Promise<T> {
    const correlationId = randomUUID();
    // The effective strategy is resolved ONCE, here, and validated before anything else touches it:
    // both the audit path below and the per-attempt header build read it, so an unusable credential
    // (a hand-built `ResolvedConfig` without `auth`) fails closed with `AuthError` on every path —
    // never a raw `TypeError` — and no request is sent.
    const auth = opts.auth ?? this.config.auth;
    if (!isAuthStrategy(auth)) throw missingAuthStrategyError();
    if (opts.dryRun === true) {
      const marker: DryRunRequest = {
        __dryRun: true,
        simulated: true,
        method: opts.method,
        path: opts.path,
        url: this.buildUrl(opts),
      };
      this.emitAudit(correlationId, opts, 'success', undefined, auth.secretHeaders);
      return marker as unknown as T;
    }
    // A dry run never reaches the transport, so it is not counted as in flight.
    this.state.inFlight += 1;
    // The SAME captured strategy instance is threaded into the transport: the audit hook redacts with
    // its declared secret header names, and every attempt builds its headers from it. The strategy
    // IDENTITY is pinned here, once, for the whole call — a caller that reuses one RequestOptions
    // object and mutates `opts.auth` mid-flight cannot switch the credential on a later attempt while
    // the audit event still redacts with the first strategy's names. What is NOT pinned is the header
    // PRODUCTION: `headers(ctx)` still runs once per attempt, so a retry may pick up a rotation.
    try {
      const result = await this.execute<T>(opts, correlationId, auth);
      this.emitAudit(correlationId, opts, 'success', undefined, auth.secretHeaders);
      return result;
    } catch (err) {
      if (err instanceof HuduError) {
        err.correlationId = correlationId;
        if (opts.operation !== undefined) err.operation = opts.operation;
        if (err.resourceIds === undefined) err.resourceIds = resourceIdsFor(opts);
      }
      this.emitAudit(correlationId, opts, 'error', err instanceof HuduError ? err.httpStatus : undefined, auth.secretHeaders);
      throw err;
    } finally {
      this.state.inFlight -= 1;
    }
  }

  /**
   * Read-only snapshot of the local limiter/queue state (see `RateLimitStatus`).
   *
   * Synchronous and side-effect free: it reads the token bucket (applying the
   * pending refill to the returned estimate, never to the bucket itself) plus the
   * live queue and in-flight counters, and returns a plain object. Use it to
   * apply backpressure — e.g. hold new MCP tool calls while `throttled` or while
   * `queued > 0` — never to acquire capacity.
   */
  getRateLimitStatus(): RateLimitStatus {
    const status: {
      enabled: boolean;
      throttled: boolean;
      availableTokens: number;
      burst: number;
      queued: number;
      inFlight: number;
      lastRetryAfterSeconds?: number;
    } = {
      enabled: this.state.bucket !== undefined,
      throttled: false,
      availableTokens: 0,
      burst: 0,
      queued: this.state.queued,
      inFlight: this.state.inFlight,
    };
    if (this.state.bucket !== undefined) {
      const refilled = Math.min(
        this.state.bucket.capacity,
        this.state.bucket.tokens + (Date.now() - this.state.bucket.lastRefill) * this.state.bucket.refillPerMs,
      );
      status.availableTokens = Math.max(0, refilled);
      status.burst = this.state.bucket.capacity;
      status.throttled = refilled < 1;
    }
    if (this.state.lastRetryAfterSeconds !== undefined) status.lastRetryAfterSeconds = this.state.lastRetryAfterSeconds;
    return status;
  }

  /**
   * Build and hand the audit event to `config.onAudit`. The event is redacted with
   * the SAME `redact()` used for logging payloads — one redactor for the SDK.
   * Returns immediately (no allocation, no hook call) when no hook is configured.
   */
  private emitAudit(
    correlationId: string,
    opts: RequestOptions,
    outcome: 'success' | 'error',
    httpStatus: number | undefined,
    secretHeaders?: readonly string[],
  ): void {
    const hook = this.config.onAudit;
    if (!hook) return;
    const event: AuditEvent = {
      correlationId,
      operation: opts.operation ?? deriveOperation(opts.method, opts.path),
      method: opts.method,
      path: opts.path,
      effect: effectForMethod(opts.method),
      dryRun: opts.dryRun === true,
      outcome,
      timestamp: new Date().toISOString(),
    };
    if (httpStatus !== undefined) event.httpStatus = httpStatus;
    const ids = resourceIdsFor(opts);
    if (ids !== undefined) event.resourceIds = ids;
    if (opts.query !== undefined) event.query = opts.query;
    // Executed-result metadata: every mutation reports its impact, reads never do.
    if (event.effect !== 'read') event.impact = opts.impact ?? defaultImpactFor(event.effect);
    hook(redact(event, secretHeaders) as AuditEvent);
  }

  /**
   * The transport proper: retries, deadline, error wrapping. Always reached through `request`, which
   * has already resolved and validated `strategy` — this method never reads `opts.auth`/`config.auth`
   * again, so the credential source cannot change under a call in flight.
   */
  private async execute<T>(opts: RequestOptions, correlationId: string, strategy: AuthStrategy): Promise<T> {
    const method = opts.method;
    const url = this.buildUrl(opts);

    const retries = opts.retries ?? true;
    const isIdempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
    const maxAttempts = retries && isIdempotent ? this.config.maxRetries + 1 : 1;

    // B8: timeoutMs bounds the WHOLE call (all attempts + backoff + rate-limit
    // wait), not each individual attempt.
    const deadline = Date.now() + this.config.timeoutMs;

    let attempt = 0;

    while (true) {
      // F1: thread the whole-call deadline into the token wait so a rate-limit
      // hold can never block far beyond timeoutMs. consumeOne() throws itself
      // when the deadline passes during the wait.
      await this.consumeToken(deadline);

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const safe = pathOnlyUrl(url);
        throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: ${method} ${safe}`, safe, TIMEOUT);
      }

      // Per-attempt credential resolution: a retry that follows a backoff sleep may pick up a
      // rotated/refreshed credential. Bounded by `remaining`, so a slow resolver cannot eat the
      // whole-call deadline silently (section 5). A failure BEFORE `fetch` must not spend limiter
      // capacity, so the token taken above is refunded on this path only.
      let headers: Record<string, string>;
      try {
        headers = await this.resolveHeaders(strategy, opts, url, correlationId, attempt, remaining);
      } catch (err) {
        this.refundToken();
        throw err;
      }

      // `timeoutMs` bounds the WHOLE call, so the network budget is what is LEFT of the deadline after
      // auth resolved — not the pre-auth `remaining`. Re-using the stale value let an async resolver
      // that consumed most of the budget silently extend the call to roughly twice `timeoutMs`.
      const remainingAfterAuth = deadline - Date.now();
      if (remainingAfterAuth <= 0) {
        const safe = pathOnlyUrl(url);
        throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: ${method} ${safe}`, safe, TIMEOUT);
      }

      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(remainingAfterAuth),
      };
      if (opts.manualRedirect) init.redirect = 'manual';
      if (opts.formUrlEncoded) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.formUrlEncoded)) params.append(k, String(v));
        init.body = params.toString();
      } else if (opts.formData) {
        init.body = opts.formData;
      } else if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
      }

      // C14: log the path only — never the query string (password/asset search terms).
      this.config.logger.debug(`${method} ${this.config.baseUrl}${this.config.basePath}${opts.path}`);

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        const safe = pathOnlyUrl(url);
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: ${method} ${safe}`, safe, TIMEOUT);
        }
        // Defense in depth: a value that reaches `Headers` anyway is echoed verbatim by the
        // TypeError. That value can be a credential, so replace the message rather than interpolate it.
        if (err instanceof Error && INVALID_HEADER_PATTERN.test(err.message)) {
          throw new HuduNetworkError(
            'Network error: an invalid HTTP header was produced; a header value is not a legal HTTP field value',
            safe,
          );
        }
        throw new HuduNetworkError(`Network error: ${err instanceof Error ? err.message : String(err)}`, safe);
      }

      // B9: a manual-redirect endpoint flows through the same transport (rate
      // limiter, retries, error wrapping) instead of a bare fetch.
      if (opts.manualRedirect) {
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          response.body?.cancel();
          return new URL(location, url).toString() as T;
        }
        if (response.ok) {
          response.body?.cancel();
          return url as T;
        }
      }

      if (attempt < maxAttempts - 1 && (response.status === 429 || response.status >= 500)) {
        // B6: release the connection body before retrying so the socket can be reused.
        response.body?.cancel();
        const retryAfter = response.status === 429 ? retryAfterSeconds(response.headers.get('retry-after')) : undefined;
        if (retryAfter !== undefined) this.state.lastRetryAfterSeconds = retryAfter;
        // Cap the delay and never sleep past the whole-call deadline (B6/B8).
        const bounded = Math.min(retryDelayMs(attempt, retryAfter), Math.max(deadline - Date.now(), 0));
        this.config.logger.warn(`HTTP ${response.status}; retrying in ${bounded}ms (attempt ${attempt + 1})`);
        await sleep(bounded);
        attempt++;
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch((err) => catchBodyError(err, method, url, this.config.timeoutMs));
        const is429 = response.status === 429;
        if (is429) {
          const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
          throw new RateLimitError(`Rate limited (HTTP 429)`, pathOnlyUrl(url), parseBody(text), retryAfter);
        }
        throw errorFromStatus(response.status, parseBody(text), pathOnlyUrl(url));
      }

      // Binary branch: return the body as a real Blob instead of text+parseBody.
      if (opts.responseType === 'blob') {
        return (await response.blob().catch((err) => catchBodyError(err, method, url, this.config.timeoutMs))) as T;
      }

      const text = await response.text().catch((err) => catchBodyError(err, method, url, this.config.timeoutMs));
      if (text.length === 0) return undefined as T;
      return parseBody(text) as T;
    }
  }

  /**
   * Resolve the credential headers for ONE attempt (issue #23).
   *
   * The strategy is the one `request()` resolved and validated for the whole call — NOT re-read from
   * `opts.auth ?? config.auth` here, so a concurrent caller reusing one `RequestOptions` object cannot
   * swap the credential mid-flight while the audit event still redacts with the first strategy's
   * declared secret headers. `headers()` is still called at most once per attempt, so a retry can pick
   * up a rotated credential. A synchronous strategy costs one object literal and adds no microtask; an
   * async one is raced against the attempt's remaining budget so it can never hold the call past the
   * whole-call deadline. Every failure is fail-closed: an `AuthError` and no request on the wire.
   */
  private async resolveHeaders(
    strategy: AuthStrategy,
    opts: RequestOptions,
    url: string,
    correlationId: string,
    attempt: number,
    remaining: number,
  ): Promise<Record<string, string>> {
    const ctx: AuthContext = {
      method: opts.method,
      path: opts.path,
      url: pathOnlyUrl(url),
      correlationId,
      attempt,
    };

    let produced: AuthHeaders | Promise<AuthHeaders>;
    let asynchronous: boolean;
    try {
      produced = strategy.headers(ctx);
      // `isThenable` reads `.then`, so it is a read of the strategy's output too: a getter or Proxy
      // trap can throw here, and the same "never interpolate the original" rule applies.
      asynchronous = isThenable(produced);
    } catch {
      // The underlying message is deliberately NOT interpolated: it may contain the credential.
      throw authFailureError(strategy.name, ctx);
    }

    let resolved: AuthHeaders;
    if (asynchronous) {
      const pending = Promise.resolve(produced);
      // We may stop awaiting `pending` on a deadline loss; absorb its later rejection so it cannot
      // surface as an unhandled rejection.
      pending.catch(() => {});
      try {
        resolved = await withDeadline(pending, remaining, () => authTimeoutError(strategy.name, ctx, remaining));
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw authFailureError(strategy.name, ctx);
      }
    } else {
      // `asynchronous` is false, so `produced` is already the map; the annotation is narrow-only.
      resolved = produced as AuthHeaders;
    }

    let credentialHeaders: AuthHeaders;
    try {
      // Enumerating and reading the produced map can itself throw (a lazy getter, a Proxy trap).
      // Same discipline as the `headers(ctx)` call above: substitute the fixed message, never the
      // original error — its message and stack may both carry the credential.
      credentialHeaders = validateAuthHeaders(strategy.name, ctx, resolved);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw authFailureError(strategy.name, ctx);
    }
    return mergeRequestHeaders(credentialHeaders, opts.headers, opts.accept, opts);
  }

  /**
   * Fetch a binary payload (e.g. an export/photo download) and return it as a
   * Blob, regardless of content type.
   */
  async download(opts: Omit<RequestOptions, 'responseType'>): Promise<Blob> {
    return this.request<Blob>({ ...opts, responseType: 'blob' });
  }

  /**
   * Issue a GET that expects a 3xx redirect and return the final Location URL.
   * Uses redirect: 'manual' so the 3xx Location header is accessible, then
   * resolves it against the request URL. Runs through the full transport
   * (rate limiter, retries, error wrapping).
   */
  async resolveRedirect(path: string, query?: Record<string, unknown>, headers?: Record<string, string>): Promise<string> {
    return this.request<string>({
      method: 'GET',
      path,
      query,
      headers,
      accept: 'text/html',
      manualRedirect: true,
    });
  }

  private buildUrl(opts: RequestOptions): string {
    const base = `${this.config.baseUrl}${this.config.basePath}${opts.path}`;
    if (!opts.query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query)) {
      // C13: empty-string and null/undefined values are deliberately dropped
      // (consistent with request sanitisation); array values serialise as repeated
      // bare keys (last-wins on the receiving side). Neither is low-risk to change.
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, String(v));
      } else {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  /**
   * Return ONE limiter token for a call that failed BEFORE `fetch` (issue #23 review, finding 3).
   *
   * `consumeToken` deducts before auth is resolved, so a strategy that rejects, times out or returns
   * unusable headers would otherwise spend capacity on a request that never left the process. With a
   * shared burst of 1, repeated auth failures starve every scope on that transport. The pending refill
   * is applied first and `lastRefill` advanced, exactly as `consumeOne` does, so the bucket stays
   * consistent; the add is capped at capacity. Never called on a path that reaches `fetch`, so no
   * successful (or attempted) request is affected.
   */
  private refundToken(): void {
    const bucket = this.state.bucket;
    if (bucket === undefined) return;
    const now = Date.now();
    bucket.tokens = Math.min(
      bucket.capacity,
      bucket.tokens + (now - bucket.lastRefill) * bucket.refillPerMs,
    );
    bucket.lastRefill = now;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
  }

  private consumeToken(deadline: number): Promise<void> {
    // B11: serialise all token acquisitions through one promise chain so N
    // concurrent callers cannot all read the same sub-1 balance and fire together.
    const attempt = this.state.consumeTail.then(() => this.consumeOne(deadline));
    this.state.consumeTail = attempt.catch(() => {});
    // If the whole-call deadline has already elapsed at enqueue time, reject
    // immediately (Promise.reject, not a synchronous throw, from a non-async fn)
    // without even enqueuing the token wait. The chain is already wired above so
    // subsequent callers are not corrupted.
    if (deadline - Date.now() <= 0) {
      return Promise.reject(
        new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: rate limit queue held past deadline`, undefined, TIMEOUT),
      );
    }
    // Bound the time spent WAITING FOR OUR TURN in the queue by the caller's own
    // deadline. consumeOne() only enforces the deadline once it actually starts,
    // which can be far past our own deadline when a request ahead of us (e.g. a
    // retry) is refill-waiting. Race the serialised turn against an expiry timer
    // and reject if the deadline fires while we are still queued.
    // Only count queued callers while a limiter is configured: with no bucket the
    // chain resolves immediately, so there is no real queue to report.
    const tracked = this.state.bucket !== undefined;
    if (tracked) this.state.queued += 1;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: rate limit queue held past deadline`, undefined, TIMEOUT),
        );
      }, deadline - Date.now());
      attempt.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    }).finally(() => {
      if (tracked) this.state.queued -= 1;
    });
  }

  private async consumeOne(deadline: number): Promise<void> {
    if (!this.state.bucket) return;
    for (;;) {
      const now = Date.now();
      this.state.bucket.tokens = Math.min(
        this.state.bucket.capacity,
        this.state.bucket.tokens + (now - this.state.bucket.lastRefill) * this.state.bucket.refillPerMs,
      );
      this.state.bucket.lastRefill = now;
      if (this.state.bucket.tokens >= 1) break;
      // F1: each wait is capped by the whole-call deadline so a rate-limit hold
      // never blocks past timeoutMs. A retry that still can't obtain a token by
      // the deadline throws a timeout instead of spinning/fetching late.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: rate limit held past deadline`, undefined, TIMEOUT);
      }
      const wait = Math.min(Math.ceil((1 - this.state.bucket.tokens) / this.state.bucket.refillPerMs), remaining);
      this.config.logger.debug(`Client rate limit reached; sleeping ${wait}ms`);
      await sleep(wait);
    }
    // Acquired a token; if the deadline elapsed while obtaining it, don't fetch late.
    if (Date.now() >= deadline) {
      throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: rate limit held past deadline`, undefined, TIMEOUT);
    }
    this.state.bucket.tokens -= 1;
  }
}

/**
 * Parse a response body. JSON is attempted first; on failure the raw text is
 * returned unchanged (B14 — intentionally conservative: non-JSON 2xx bodies such
 * as WAF/proxy HTML are surfaced verbatim rather than rejected, and valid JSON
 * text responses are never broken).
 */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
