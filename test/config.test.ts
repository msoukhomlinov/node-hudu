/**
 * Config validation tests.
 */
import { describe, it, expect } from 'vitest';
import { resolveConfig, DEFAULT_BASE_PATH, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_RATE_LIMIT_PER_MINUTE } from '../src/config.js';
import { HuduConfigError } from '../src/errors.js';
import { ApiKeyAuth, BearerTokenAuth } from '../src/auth.js';

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

  it('rejects timeoutMs 0 (would abort every request) (B12)', () => {
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', timeoutMs: 0 })).toThrow(HuduConfigError);
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

  it('rejects an invalid rateLimit.burst (B12)', () => {
    const base = { baseUrl: 'https://hudu.example.com', apiKey: 'k' };
    expect(() => resolveConfig({ ...base, rateLimit: { perMinute: 10, burst: 0 } })).toThrow(HuduConfigError);
    expect(() => resolveConfig({ ...base, rateLimit: { perMinute: 10, burst: -1 } })).toThrow(HuduConfigError);
    expect(() => resolveConfig({ ...base, rateLimit: { perMinute: 10, burst: 2.5 } })).toThrow(HuduConfigError);
  });

  it('throws a HuduConfigError for a missing config', () => {
    expect(() => resolveConfig(undefined as never)).toThrow(HuduConfigError);
  });
});

describe('resolveConfig — the credential matrix (issue #23)', () => {
  const BASE_URL = 'https://hudu.example.com';

  function codeOf(run: () => unknown): string | undefined {
    try {
      run();
      return undefined;
    } catch (err) {
      expect(err).toBeInstanceOf(HuduConfigError);
      expect((err as HuduConfigError).category).toBe('validation');
      return (err as HuduConfigError).code;
    }
  }

  it('row 4: refuses both apiKey and auth', () => {
    expect(codeOf(() => resolveConfig({ baseUrl: BASE_URL, apiKey: 'k', auth: new BearerTokenAuth('t') })))
      .toBe('CONFIG_ERROR');
  });

  it('row 5: refuses neither credential and names the alternative', () => {
    expect(codeOf(() => resolveConfig({ baseUrl: BASE_URL }))).toBe('CONFIG_ERROR');
    try {
      resolveConfig({ baseUrl: BASE_URL });
    } catch (err) {
      expect((err as HuduConfigError).message).toBe('apiKey must be a non-empty string, or provide an "auth" strategy');
    }
    // `apiKey: undefined` is the same "absent" case, not a blank one.
    expect(codeOf(() => resolveConfig({ baseUrl: BASE_URL, apiKey: undefined }))).toBe('CONFIG_ERROR');
  });

  it('row 6/7: refuses a blank apiKey, with the unchanged message', () => {
    for (const apiKey of ['', '   ', '\t']) {
      try {
        resolveConfig({ baseUrl: BASE_URL, apiKey });
        throw new Error('expected a refusal');
      } catch (err) {
        expect((err as HuduConfigError).code).toBe('CONFIG_ERROR');
        expect((err as HuduConfigError).message).toBe('apiKey must be a non-empty string');
      }
    }
  });

  it('row 8: refuses a non-string apiKey', () => {
    expect(codeOf(() => resolveConfig({ baseUrl: BASE_URL, apiKey: 42 as never }))).toBe('CONFIG_ERROR');
  });

  it('row 9: a non-string apiKey is invalid, not absent, even with auth', () => {
    expect(codeOf(() => resolveConfig({ baseUrl: BASE_URL, apiKey: 42 as never, auth: new BearerTokenAuth('t') })))
      .toBe('CONFIG_ERROR');
  });

  it('row 10: a blank apiKey plus auth is accepted, and the strategy wins', () => {
    const auth = new BearerTokenAuth('t');
    const cfg = resolveConfig({ baseUrl: BASE_URL, apiKey: '', auth });
    expect(cfg.auth).toBe(auth);
    expect(cfg.apiKey).toBe('');
    expect(cfg.baseUrl).toBe(BASE_URL);
  });

  it('row 11: an invalid auth shape is refused', () => {
    expect(codeOf(() => resolveConfig({ baseUrl: BASE_URL, auth: {} as never }))).toBe('CONFIG_ERROR');
    expect(codeOf(() => resolveConfig({ baseUrl: BASE_URL, auth: { name: 'x' } as never }))).toBe('CONFIG_ERROR');
    expect(codeOf(() => resolveConfig({ baseUrl: BASE_URL, auth: 'nope' as never }))).toBe('CONFIG_ERROR');
  });

  it('rows 1/2: an apiKey client gets a trimmed key and a derived ApiKeyAuth', () => {
    const cfg = resolveConfig({ baseUrl: BASE_URL, apiKey: '  abc  ' });
    expect(cfg.apiKey).toBe('abc');
    expect(cfg.auth).toBeInstanceOf(ApiKeyAuth);
    expect(cfg.auth.headers({} as never)).toEqual({ 'x-api-key': 'abc' });
  });

  it('every other config field keeps its default with a strategy', () => {
    const cfg = resolveConfig({ baseUrl: BASE_URL, auth: new BearerTokenAuth('t') });
    expect(cfg.basePath).toBe('/api/v1');
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(cfg.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(cfg.rateLimit).toBeUndefined();
  });
});
