/**
 * Configuration and validation for the Hudu client.
 */
import { HuduConfigError } from './errors.js';
import type { Logger } from './logger.js';
import { NOOP_LOGGER } from './logger.js';

export interface RateLimitConfig {
  /** Max requests per minute. Default 300 (Hudu's documented limit). Must be > 0. */
  perMinute?: number;
  /** Optional max burst beyond steady rate. Default equals perMinute. */
  burst?: number;
}

export interface HuduConfig {
  /** Origin only, e.g. 'https://hudu.example.com'. No path, no trailing slash. */
  baseUrl: string;
  /** Hudu API key. */
  apiKey: string;
  /** Defaults to '/api/v1' — the swagger basePath. */
  basePath?: string;
  /** Whole-call deadline in ms (requests + retries + backoff + rate-limit wait). Default 30_000. */
  timeoutMs?: number;
  /** Retry budget for idempotent requests (GET/PUT/DELETE) on 429/5xx. Default 3 (0 disables). */
  maxRetries?: number;
  /** Optional request log sink. */
  logger?: Logger;
  /** Optional client-side rate limiter (token bucket). Off by default. */
  rateLimit?: RateLimitConfig;
}

export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  basePath: string;
  timeoutMs: number;
  maxRetries: number;
  logger: Logger;
  rateLimit?: Required<RateLimitConfig>;
}

export const DEFAULT_BASE_PATH = '/api/v1';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 300;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_PAGE_SIZE = 25;

/** Validate a baseUrl origin and strip trailing slashes. */
function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HuduConfigError(`Invalid baseUrl: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HuduConfigError(`baseUrl must use http: or https:, got "${url.protocol}"`);
  }
  if (url.pathname && url.pathname !== '/') {
    throw new HuduConfigError(`baseUrl must be an origin (no path). Got path "${url.pathname}"`);
  }
  return url.origin;
}

/** Resolve + validate a HuduConfig into a ResolvedConfig. */
export function resolveConfig(config: HuduConfig): ResolvedConfig {
  if (!config || typeof config !== 'object') {
    throw new HuduConfigError('HuduConfig is required');
  }
  if (!config.apiKey || typeof config.apiKey !== 'string' || config.apiKey.trim().length === 0) {
    throw new HuduConfigError('apiKey must be a non-empty string');
  }
  if (config.basePath !== undefined && !config.basePath.startsWith('/')) {
    throw new HuduConfigError('basePath must start with "/"');
  }
  // B12: timeoutMs must be strictly positive — 0 makes AbortSignal.timeout(0)
  // abort every request immediately.
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new HuduConfigError('timeoutMs must be a positive integer');
  }
  if (config.maxRetries !== undefined && (!Number.isInteger(config.maxRetries) || config.maxRetries < 0)) {
    throw new HuduConfigError('maxRetries must be a non-negative integer');
  }

  let rateLimit: Required<RateLimitConfig> | undefined;
  if (config.rateLimit) {
    const perMinute = config.rateLimit.perMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    if (!Number.isInteger(perMinute) || perMinute <= 0) {
      throw new HuduConfigError('rateLimit.perMinute must be a positive integer');
    }
    // B12: a burst of 0/negative/non-integer would leave a permanently-empty token bucket.
    const burst = config.rateLimit.burst ?? perMinute;
    if (!Number.isInteger(burst) || burst <= 0) {
      throw new HuduConfigError('rateLimit.burst must be a positive integer');
    }
    rateLimit = { perMinute, burst };
  }

  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: config.apiKey.trim(),
    basePath: config.basePath ?? DEFAULT_BASE_PATH,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    logger: config.logger ?? NOOP_LOGGER,
    rateLimit,
  };
}
