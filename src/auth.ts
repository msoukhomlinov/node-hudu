/**
 * Authentication header construction.
 *
 * The Hudu API authenticates via the `x-api-key` header. `API_KEY_HEADER`, `buildAuthHeaders` and
 * `withAuth` are the original, unchanged surface. A pluggable `AuthStrategy` (issue #23) lets a host
 * supply the credential per client — for example the end user's own Hudu API key in a multi-tenant
 * MCP server — and lets a deployment that fronts Hudu with a bearer-accepting proxy send
 * `Authorization` instead.
 */
import { HuduConfigError } from './errors.js';

export const API_KEY_HEADER = 'x-api-key';

export function buildAuthHeaders(apiKey: string): Record<string, string> {
  return { [API_KEY_HEADER]: apiKey };
}

export function withAuth(
  headers: Record<string, string> | undefined,
  apiKey: string,
): Record<string, string> {
  return { ...buildAuthHeaders(apiKey), ...(headers ?? {}) };
}

/** A header map produced by a strategy. Every value must be a non-empty string. */
export type AuthHeaders = Record<string, string>;

/**
 * Everything a strategy may know about the request it is authenticating.
 *
 * Deliberately small and credential-free: a context never carries a previously resolved credential,
 * so a strategy cannot accidentally echo one back into a header.
 */
export interface AuthContext {
  /** HTTP method of the attempt. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path after `basePath`, already interpolated, without the query string (e.g. '/companies/42'). */
  readonly path: string;
  /** Absolute URL with the query string stripped — the same string an error message would carry. */
  readonly url: string;
  /** One id per call, identical on every attempt of that call; also on every thrown `HuduError`. */
  readonly correlationId: string;
  /** 0 for the first attempt, incremented on every retry. */
  readonly attempt: number;
}

/**
 * A pluggable credential source.
 *
 * `headers()` is called at most ONCE PER ATTEMPT and only when a request is really about to be sent:
 *
 * - never for a dry run (`{ dryRun: true }` short-circuits before the transport),
 * - never at construction, so `new HuduClient(...)` still issues no request,
 * - at most `maxRetries + 1` times per call (default 4), so a retry after backoff may pick up a
 *   rotated or refreshed credential.
 *
 * The SDK caches nothing. A strategy that must not do repeated lookups should memoise in its own
 * closure and key on `ctx.correlationId`. The SDK may stop waiting for `headers()` when it outlives
 * the request's remaining budget (`timeoutMs` bounds the whole call), so an I/O-bound lookup should
 * be abortable on the strategy's own side.
 */
export interface AuthStrategy {
  /** Short, stable label used in error messages (and nowhere else). e.g. 'api-key'. */
  readonly name: string;
  /** Produce the credential headers for one attempt. May be async. */
  headers(ctx: AuthContext): AuthHeaders | Promise<AuthHeaders>;
  /**
   * Extra header NAMES this strategy treats as secret. Used to extend the redactor for SDK-emitted
   * payloads (audit events). Optional — the built-ins declare theirs, and `HeaderAuth` defaults to
   * every header name it was constructed with.
   */
  readonly secretHeaders?: readonly string[];
}

/** True when `value` looks like a strategy: an object with a string `name` and a `headers` function. */
export function isAuthStrategy(value: unknown): value is AuthStrategy {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { name?: unknown; headers?: unknown };
  return typeof candidate.name === 'string' && candidate.name.length > 0 && typeof candidate.headers === 'function';
}

/**
 * The default strategy: the historical `x-api-key` header, trimmed, refused when blank.
 * `resolveConfig` builds one for every `apiKey` client, so this is not a second code path — it is
 * the SAME header production, now named.
 */
export class ApiKeyAuth implements AuthStrategy {
  readonly name = 'api-key';
  readonly secretHeaders: readonly string[] = [API_KEY_HEADER];
  private readonly key: string;

  /** Throws `HuduConfigError` (code `CONFIG_ERROR`) for a blank key: a credential-less request is never built. */
  constructor(apiKey: string) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new HuduConfigError('ApiKeyAuth requires a non-empty apiKey');
    }
    this.key = apiKey.trim();
  }

  headers(): AuthHeaders {
    return buildAuthHeaders(this.key);
  }
}

/**
 * `Authorization: Bearer <token>`. For a deployment that fronts Hudu with a bearer-accepting proxy;
 * Hudu itself does not define a bearer scheme in its API document.
 */
export class BearerTokenAuth implements AuthStrategy {
  readonly name = 'bearer-token';
  readonly secretHeaders: readonly string[] = ['authorization'];
  private readonly token: string;

  /** Throws `HuduConfigError` (code `CONFIG_ERROR`) for a blank token. */
  constructor(token: string) {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new HuduConfigError('BearerTokenAuth requires a non-empty token');
    }
    this.token = token.trim();
  }

  headers(): AuthHeaders {
    return { Authorization: `Bearer ${this.token}` };
  }
}

/**
 * Any fixed header set (a custom credential header, a tenant router header, an mTLS-less proxy
 * token). Constructed from the complete map, so the caller decides the wire shape.
 */
export class HeaderAuth implements AuthStrategy {
  readonly name: string;
  /** Defaults to every header name given — a custom credential header is secret unless declared otherwise. */
  readonly secretHeaders: readonly string[];
  private readonly values: AuthHeaders;

  /**
   * @param headers Non-empty map of header name to a non-empty string value.
   * @param options `name` (default 'header') and an explicit `secretHeaders` list to narrow redaction.
   * Throws `HuduConfigError` (code `CONFIG_ERROR`) for an empty map or a blank value.
   */
  constructor(headers: Record<string, string>, options: { name?: string; secretHeaders?: readonly string[] } = {}) {
    const entries = Object.entries(headers ?? {});
    if (entries.length === 0) {
      throw new HuduConfigError('HeaderAuth requires at least one header');
    }
    for (const [key, value] of entries) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HuduConfigError(`HeaderAuth header "${key}" must be a non-empty string`);
      }
    }
    this.values = { ...headers };
    this.name = options.name ?? 'header';
    this.secretHeaders = options.secretHeaders ?? entries.map(([key]) => key);
  }

  headers(): AuthHeaders {
    // A copy per call: the transport merges into its own object and never mutates a strategy's map.
    return { ...this.values };
  }
}
