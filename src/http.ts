/**
 * HTTP transport using native fetch (Node >= 18). Zero runtime dependencies.
 */
import { withAuth } from './auth.js';
import type { ResolvedConfig } from './config.js';
import { errorFromStatus, HuduNetworkError, RateLimitError } from './errors.js';
import { isRecord } from './utils.js';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path after basePath, e.g. '/companies/{id}' (already interpolated). */
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  formData?: FormData;
  headers?: Record<string, string>;
  /** Override Accept header (e.g. 'text/html' for redirect endpoints). */
  accept?: string;
  /** Default true. POST is never retried; set false to opt out of retries for others. */
  retries?: boolean;
}

/** If data is an object with key, returns data[key]; otherwise returns data. */
export function unwrapByKey<T>(data: unknown, key?: string): T {
  if (isRecord(data) && key && key in data) return data[key] as T;
  return (key ? (isRecord(data) ? data : {}) : data) as T;
}

/** For list responses: expects data[key] to be an array; otherwise passes body through as T[]. */
export function unwrapList<T>(data: unknown, key?: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (isRecord(data) && key && Array.isArray(data[key])) return data[key] as T[];
  return [];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
}

export class HttpClient {
  private readonly config: ResolvedConfig;
  private bucket?: TokenBucket;

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
    if (opts.body !== undefined && !opts.formData) {
      headers['Content-Type'] = 'application/json';
    }

    const retries = opts.retries ?? true;
    const isIdempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
    const maxAttempts = retries && isIdempotent ? this.config.maxRetries + 1 : 1;

    let attempt = 0;
     
    while (true) {
      await this.consumeToken();
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      };
      if (opts.formData) {
        init.body = opts.formData;
      } else if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
      }

      this.config.logger.debug(`${method} ${url}`);

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          throw new HuduNetworkError(`Request timed out after ${this.config.timeoutMs}ms: ${method} ${url}`, url);
        }
        throw new HuduNetworkError(`Network error: ${err instanceof Error ? err.message : String(err)}`, url);
      }

      if (response.status === 429 && attempt < maxAttempts - 1) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '');
        const delay = retryAfter ? retryAfter * 1000 : 200 * (2 ** attempt);
        this.config.logger.warn(`Rate limited (429); retrying in ${delay}ms (attempt ${attempt + 1})`);
        await sleep(delay);
        attempt++;
        continue;
      }
      if (response.status >= 500 && attempt < maxAttempts - 1) {
        const delay = 200 * (2 ** attempt);
        this.config.logger.warn(`Server error (${response.status}); retrying in ${delay}ms`);
        await sleep(delay);
        attempt++;
        continue;
      }

      const text = await response.text();

      if (!response.ok) {
        const is429 = response.status === 429;
        if (is429) {
          const retryAfter = Number(response.headers.get('retry-after') ?? '');
          throw new RateLimitError(`Rate limited (HTTP 429)`, url, parseBody(text), Number.isFinite(retryAfter) ? retryAfter : undefined);
        }
        throw errorFromStatus(response.status, parseBody(text), url);
      }

      if (text.length === 0) return undefined as T;
      return parseBody(text) as T;
    }
  }

  /**
   * Issue a GET that expects a 3xx redirect and return the final Location URL.
   * Uses redirect: 'manual' so the 3xx Location header is accessible, then
   * resolves it against the request URL.
   */
  async resolveRedirect(path: string, query?: Record<string, unknown>, headers?: Record<string, string>): Promise<string> {
    const url = this.buildUrl({ method: 'GET', path, query, headers, accept: 'text/html' });
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...withAuth(headers, this.config.apiKey), Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) return new URL(location, url).toString();
    }
    // If the server returned 200 with a body (some setups), return the requested URL.
    if (response.ok) return url;
    throw errorFromStatus(response.status, await response.text(), url);
  }

  private buildUrl(opts: RequestOptions): string {
    const base = `${this.config.baseUrl}${this.config.basePath}${opts.path}`;
    if (!opts.query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query)) {
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

  private async consumeToken(): Promise<void> {
    if (!this.bucket) return;
    const now = Date.now();
    this.bucket.tokens = Math.min(
      this.bucket.capacity,
      this.bucket.tokens + (now - this.bucket.lastRefill) * this.bucket.refillPerMs,
    );
    if (this.bucket.tokens < 1) {
      const wait = Math.ceil((1 - this.bucket.tokens) / this.bucket.refillPerMs);
      this.config.logger.debug(`Client rate limit reached; sleeping ${wait}ms`);
      await sleep(wait);
    }
    this.bucket.tokens -= 1;
    this.bucket.lastRefill = now;
  }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
