/**
 * Minimal logging contract. Consumers may pass `console` or any object matching
 * this interface; credentials are always redacted before reaching the logger.
 */
import { isRecord } from './utils.js';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Default no-op logger. */
export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Replacement value written over every credential-shaped key. */
export const REDACTED = '[REDACTED]';

/**
 * Credential-shaped keys redacted by `redact` (case-insensitive). Keys ending in
 * `_token`, `_secret` or `_password` are also redacted.
 *
 * The set covers the credential NAMES, not the suffix patterns alone: a field named
 * `passphrase`, `credential(s)`, `auth`, `basic_auth` or `session` carries a secret and would
 * otherwise pass through to an audit event or a log line unmasked (found by a security review of
 * the audit surface; whether the vendor's own API uses these names is not what makes the redactor
 * correct — the caller's payload can).
 */
export const REDACTED_KEYS = [
  'password',
  'passphrase',
  'otp_secret',
  'api_key',
  'token',
  'secret',
  'authorization',
  'auth',
  'basic_auth',
  'credential',
  'credentials',
  'session',
  'x-api-key',
  'client_secret',
  'private_key',
] as const;

/**
 * Credential keys are compared with separators REMOVED, so every spelling of the same field matches:
 * `api_key`, `apiKey`, `API_KEY`, `api-key` and `apikey` all normalise to `apikey`. Live sandbox testing
 * found that the camelCase `apiKey` - the name the SDK's own config uses, and the one most JSON bodies use -
 * was NOT masked, so a credential could reach an audit event or a log line unmasked.
 */
function normalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

const REDACTED_KEY_SET: ReadonlySet<string> = new Set<string>(REDACTED_KEYS.map(normalizeCredentialKey));
const REDACTED_SUFFIXES = ['token', 'secret', 'password'] as const;

/** True when a key's name is credential-shaped and must never reach a log or audit payload. */
export function isCredentialKey(key: string): boolean {
  const normalized = normalizeCredentialKey(key);
  if (REDACTED_KEY_SET.has(normalized)) return true;
  return REDACTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * A plain record: an object whose prototype is Object.prototype or null. Class
 * instances (Blob, Date, Error, ...) are opaque and returned unchanged.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively replace credential-shaped keys with `[REDACTED]`. Returns a copy —
 * the input is never mutated — and is the ONE redactor used by the SDK's audit
 * events and available to callers as an opt-in helper for returned data
 * (policy §7.3). Returned data is never redacted implicitly.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isCredentialKey(key) ? REDACTED : redact(item);
  }
  return out;
}
