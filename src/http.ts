/**
 * HTTP transport using native fetch (Node >= 18). Zero runtime dependencies.
 */
import { withAuth } from './auth.js';
import type { ResolvedConfig } from './config.js';
import { errorFromStatus, HuduError, HuduNetworkError, RateLimitError } from './errors.js';
import { isRecord } from './utils.js';

/** Hard cap on any single retry/backoff sleep (B6). */
const MAX_RETRY_DELAY_MS = 30_000;

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
}

/** Parse a Retry-After header. Returns undefined when absent or not finite. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
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
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    throw new HuduNetworkError(`Request timed out after ${timeoutMs}ms: ${method} ${url}`, url);
  }
  const detail = err instanceof Error ? err.message : String(err);
  throw new HuduNetworkError(`Network error while reading response body: ${detail}`, url);
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
}

export class HttpClient {
  private readonly config: ResolvedConfig;
  private bucket?: TokenBucket;
  /** Serialises concurrent token acquisitions so the configured burst is really enforced (B11). */
  private consumeTail: Promise<void> = Promise.resolve();

  constructor(config: ResolvedConfig) {
    this.config = config;
    if (config.rateLimit) {
      this.bucket = {
        tokens: config.rateLimit.burst,
        lastRefill: Date.now(),
        capacity: config.rateLimit.burst,
        refillPerMs: config.rateLimit.perMinute / 60000,
      };
    }
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const method = opts.method;
    const url = this.buildUrl(opts);
    const headers: Record<string, string> = {
      ...withAuth(opts.headers, this.config.apiKey),
      Accept: opts.accept ?? 'application/json',
    };
    if (opts.formUrlEncoded) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (opts.body !== undefined && !opts.formData) {
      headers['Content-Type'] = 'application/json';
    }

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
        throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: ${method} ${url}`, url);
      }

      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(remaining),
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
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: ${method} ${url}`, url);
        }
        throw new HuduNetworkError(`Network error: ${err instanceof Error ? err.message : String(err)}`, url);
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
          throw new RateLimitError(`Rate limited (HTTP 429)`, url, parseBody(text), retryAfter);
        }
        throw errorFromStatus(response.status, parseBody(text), url);
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

  private consumeToken(deadline: number): Promise<void> {
    // B11: serialise all token acquisitions through one promise chain so N
    // concurrent callers cannot all read the same sub-1 balance and fire together.
    const attempt = this.consumeTail.then(() => this.consumeOne(deadline));
    this.consumeTail = attempt.catch(() => {});
    // If the whole-call deadline has already elapsed at enqueue time, reject
    // immediately (Promise.reject, not a synchronous throw, from a non-async fn)
    // without even enqueuing the token wait. The chain is already wired above so
    // subsequent callers are not corrupted.
    if (deadline - Date.now() <= 0) {
      return Promise.reject(
        new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: rate limit queue held past deadline`),
      );
    }
    // Bound the time spent WAITING FOR OUR TURN in the queue by the caller's own
    // deadline. consumeOne() only enforces the deadline once it actually starts,
    // which can be far past our own deadline when a request ahead of us (e.g. a
    // retry) is refill-waiting. Race the serialised turn against an expiry timer
    // and reject if the deadline fires while we are still queued.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: rate limit queue held past deadline`),
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
    });
  }

  private async consumeOne(deadline: number): Promise<void> {
    if (!this.bucket) return;
    for (;;) {
      const now = Date.now();
      this.bucket.tokens = Math.min(
        this.bucket.capacity,
        this.bucket.tokens + (now - this.bucket.lastRefill) * this.bucket.refillPerMs,
      );
      this.bucket.lastRefill = now;
      if (this.bucket.tokens >= 1) break;
      // F1: each wait is capped by the whole-call deadline so a rate-limit hold
      // never blocks past timeoutMs. A retry that still can't obtain a token by
      // the deadline throws a timeout instead of spinning/fetching late.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: rate limit held past deadline`);
      }
      const wait = Math.min(Math.ceil((1 - this.bucket.tokens) / this.bucket.refillPerMs), remaining);
      this.config.logger.debug(`Client rate limit reached; sleeping ${wait}ms`);
      await sleep(wait);
    }
    // Acquired a token; if the deadline elapsed while obtaining it, don't fetch late.
    if (Date.now() >= deadline) {
      throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: rate limit held past deadline`);
    }
    this.bucket.tokens -= 1;
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
