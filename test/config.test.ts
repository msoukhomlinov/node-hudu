/**
 * Config validation tests.
 */
import { describe, it, expect } from 'vitest';
import { resolveConfig, DEFAULT_BASE_PATH, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_RATE_LIMIT_PER_MINUTE } from '../src/config.js';
import { HuduConfigError } from '../src/errors.js';

describe('resolveConfig', () => {
  it('accepts a valid https origin', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'abc123' });
    expect(cfg.baseUrl).toBe('https://hudu.example.com');
    expect(cfg.apiKey).toBe('abc123');
  });

  it('accepts a valid http origin', () => {
    const cfg = resolveConfig({ baseUrl: 'http://hudu.local', apiKey: 'k' });
    expect(cfg.baseUrl).toBe('http://hudu.local');
  });

  it('strips a trailing slash from baseUrl', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com/', apiKey: 'k' });
    expect(cfg.baseUrl).toBe('https://hudu.example.com');
  });

  it('rejects a non-http(s) protocol', () => {
    expect(() => resolveConfig({ baseUrl: 'ftp://hudu.example.com', apiKey: 'k' })).toThrow(HuduConfigError);
  });

  it('rejects a baseUrl with a path', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com/foo', apiKey: 'k' })).toThrow(HuduConfigError);
  });

  it('rejects an unparseable baseUrl', () => {
    expect(() => resolveConfig({ baseUrl: 'not a url', apiKey: 'k' })).toThrow(HuduConfigError);
  });

  it('rejects a missing apiKey', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: '' })).toThrow(HuduConfigError);
  });

  it('trims whitespace from apiKey', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: '  key  ' });
    expect(cfg.apiKey).toBe('key');
  });

  it('normalizes basePath with a leading slash', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', basePath: '/v2' });
    expect(cfg.basePath).toBe('/v2');
  });

  it('defaults basePath to /api/v1', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
    expect(cfg.basePath).toBe(DEFAULT_BASE_PATH);
  });

  it('rejects a basePath without a leading slash', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', basePath: 'v2' })).toThrow(HuduConfigError);
  });

  it('defaults timeoutMs and maxRetries', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(cfg.maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  it('rejects negative timeoutMs', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', timeoutMs: -1 })).toThrow(HuduConfigError);
  });

  it('rejects non-integer timeoutMs', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', timeoutMs: 12.5 })).toThrow(HuduConfigError);
  });

  it('rejects negative maxRetries', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', maxRetries: -2 })).toThrow(HuduConfigError);
  });

  it('rejects non-integer maxRetries', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', maxRetries: 1.5 })).toThrow(HuduConfigError);
  });

  it('accepts zero maxRetries (disables retries)', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', maxRetries: 0 });
    expect(cfg.maxRetries).toBe(0);
  });

  it('defaults rateLimit.perMinute and burst', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', rateLimit: {} });
    expect(cfg.rateLimit).toEqual({ perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE, burst: DEFAULT_RATE_LIMIT_PER_MINUTE });
  });

  it('rejects rateLimit.perMinute <= 0', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', rateLimit: { perMinute: 0 } })).toThrow(HuduConfigError);
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', rateLimit: { perMinute: -5 } })).toThrow(HuduConfigError);
  });

  it('rejects a non-integer rateLimit.perMinute', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', rateLimit: { perMinute: 3.7 } })).toThrow(HuduConfigError);
  });

  it('respects a custom burst', () => {
    const cfg = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', rateLimit: { perMinute: 10, burst: 20 } });
    expect(cfg.rateLimit?.burst).toBe(20);
  });

  it('throws a HuduConfigError for a missing config', () => {
    expect(() => resolveConfig(undefined as never)).toThrow(HuduConfigError);
  });
});
