/**
 * Pluggable auth strategy tests (issue #23).
 *
 * Nothing here touches the network: every request goes through the `stubFetch` helpers, whose shape
 * validation fails the test on a request a real Hudu tenant could never answer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  API_KEY_HEADER, ApiKeyAuth, BearerTokenAuth, HeaderAuth, buildAuthHeaders, isAuthStrategy, withAuth,
  type AuthContext, type AuthStrategy,
} from '../src/auth.js';
import { HuduClient } from '../src/client.js';
import { resolveConfig, type ResolvedConfig } from '../src/config.js';
import { AuthError, HuduConfigError, HuduNetworkError, UnauthorizedError } from '../src/errors.js';
import { HttpClient } from '../src/http.js';
import { REDACTED, isCredentialKey, redact, type Logger } from '../src/logger.js';
import { clearFetch, expectRequests, json, stubFetch, stubFetchAny, type FetchSpy } from './helpers.js';

const BASE = 'https://hudu.example.com';

function headersOf(spy: FetchSpy, index = 0): Record<string, string> {
  return (spy.calls[index]?.init.headers ?? {}) as Record<string, string>;
}

function httpFor(config: Record<string, unknown>): HttpClient {
  return new HttpClient(resolveConfig({ baseUrl: BASE, ...config } as never));
}

/** A strategy whose `headers()` returns `values[0]`, `values[1]`, ... and counts its calls. */
function countingStrategy(values: string[]): { strategy: AuthStrategy; count: () => number; contexts: AuthContext[] } {
  let calls = 0;
  const contexts: AuthContext[] = [];
  const strategy: AuthStrategy = {
    name: 'counting',
    headers(ctx) {
      contexts.push(ctx);
      const value = values[Math.min(calls, values.length - 1)] ?? 'tok';
      calls += 1;
      return { [API_KEY_HEADER]: value };
    },
  };
  return { strategy, count: () => calls, contexts };
}

describe('auth strategies reach the wire', () => {
  afterEach(() => clearFetch());

  it('ApiKeyAuth sends x-api-key on the wire', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, auth: new ApiKeyAuth('key-A') });
    await client.companies.get(1);
    expect(headersOf(spy)['x-api-key']).toBe('key-A');
  });

  it('BearerTokenAuth sends Authorization: Bearer and no x-api-key', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, auth: new BearerTokenAuth('tok-A') });
    await client.companies.get(1);
    expect(headersOf(spy)['Authorization']).toBe('Bearer tok-A');
    expect(headersOf(spy)['x-api-key']).toBeUndefined();
  });

  it('HeaderAuth sends exactly the caller headers', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, auth: new HeaderAuth({ 'x-tenant-key': 't1' }) });
    await client.companies.get(1);
    expect(headersOf(spy)['x-tenant-key']).toBe('t1');
    expect(headersOf(spy)['x-api-key']).toBeUndefined();
  });

  it('an apiKey config still sends x-api-key and derives an ApiKeyAuth', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, apiKey: 'k' });
    expect(client.config.auth).toBeInstanceOf(ApiKeyAuth);
    await client.companies.get(1);
    expect(headersOf(spy)['x-api-key']).toBe('k');
  });

  it('resolveConfig derives ApiKeyAuth from apiKey and leaves apiKey empty for a strategy', () => {
    expect(resolveConfig({ baseUrl: BASE, apiKey: ' k ' }).auth).toBeInstanceOf(ApiKeyAuth);
    expect(resolveConfig({ baseUrl: BASE, apiKey: ' k ' }).apiKey).toBe('k');
    const auth = new BearerTokenAuth('t');
    const cfg = resolveConfig({ baseUrl: BASE, auth });
    expect(cfg.auth).toBe(auth);
    expect(cfg.apiKey).toBe('');
  });

  it('download() carries the strategy credential (the blob branch shares the funnel)', async () => {
    const spy = stubFetch(() => new Response(new Blob(['x'])), { baseUrl: BASE });
    const blob = await httpFor({ auth: new BearerTokenAuth('tok-D') }).download({ method: 'GET', path: '/exports/1' });
    expect(blob).toBeInstanceOf(Blob);
    expect(headersOf(spy)['Authorization']).toBe('Bearer tok-D');
  });

  it('resolveRedirect() carries the strategy credential (the manual-redirect branch shares the funnel)', async () => {
    const spy = stubFetch(
      () => new Response(null, { status: 302, headers: { location: '/api/v1/companies/9' } }),
      { baseUrl: BASE },
    );
    const url = await httpFor({ auth: new BearerTokenAuth('tok-R') }).resolveRedirect('/companies/jump');
    expect(url).toBe('https://hudu.example.com/api/v1/companies/9');
    expect(headersOf(spy)['Authorization']).toBe('Bearer tok-R');
  });

  it('a per-request auth override wins over the client strategy', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    const http = httpFor({ apiKey: 'client-key' });
    await http.request({ method: 'GET', path: '/companies', auth: new BearerTokenAuth('override') });
    const headers = headersOf(spy);
    expect(headers['Authorization']).toBe('Bearer override');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('the AuthContext describes the attempt, without any credential', async () => {
    const TOKEN = 'AUTHCONTEXT-SECRET-8f3c1d';
    stubFetch(() => json({}), { baseUrl: BASE });
    let seen: AuthContext | undefined;
    const strategy: AuthStrategy = {
      name: 'capture',
      headers(ctx) {
        seen = ctx;
        return { [API_KEY_HEADER]: TOKEN };
      },
    };
    // The token really is in the inputs below: it is the credential the strategy produced AND it is
    // echoed in a credential-shaped query field. So these assertions fail the moment a log line starts
    // carrying the headers, or `redact()` stops masking the audit payload.
    const sink: string[] = [];
    const logger: Logger = {
      debug: (message: string) => { sink.push(message); },
      info: (message: string) => { sink.push(message); },
      warn: (message: string) => { sink.push(message); },
      error: (message: string) => { sink.push(message); },
    };
    const audit: unknown[] = [];
    const http = httpFor({ auth: strategy, logger, onAudit: (e: unknown) => audit.push(e) });
    await http.request({
      method: 'GET',
      path: '/companies/7',
      query: { page: 2, authorization: `Bearer ${TOKEN}` },
    });
    expect(seen).toEqual({
      method: 'GET',
      path: '/companies/7',
      url: 'https://hudu.example.com/api/v1/companies/7',
      correlationId: expect.any(String) as unknown as string,
      attempt: 0,
    });
    expect(sink.length).toBeGreaterThan(0);
    expect(sink.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    // Proof the token really did travel through the redactor: the query field it echoed is present
    // in the audit event and carries the mask, not the credential.
    expect((audit[0] as { query?: Record<string, unknown> }).query?.authorization).toBe(REDACTED);
    expect((audit[0] as { query?: Record<string, unknown> }).query?.page).toBe(2);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });
});

describe('scoped clients (withAuth) never leak credentials', () => {
  afterEach(() => clearFetch());

  it('two scopes in flight carry their own credential', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, apiKey: 'parent' });
    const a = client.withAuth('key-A');
    const b = client.withAuth('key-B');
    await Promise.all([a.companies.get(1), b.companies.get(2)]);
    // Map by URL: the transport interleaves, so a call index means nothing here.
    const keyFor = (path: string) => {
      const call = spy.calls.find((c) => new URL(c.url).pathname === path);
      return ((call?.init.headers ?? {}) as Record<string, string>)['x-api-key'];
    };
    expect(keyFor('/api/v1/companies/1')).toBe('key-A');
    expect(keyFor('/api/v1/companies/2')).toBe('key-B');
    expect(spy.calls).toHaveLength(2);
  });

  it('a scoped client shares the parent rate-limit state and logger, but not the credential', async () => {
    stubFetchAny({ baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, apiKey: 'parent', rateLimit: { perMinute: 60, burst: 60 } });
    const scoped = client.withAuth('key-A');
    await scoped.companies.get(1);
    // One bucket for the whole tree: the scope's call consumed the parent's token.
    expect(scoped.getRateLimitStatus().availableTokens).toBeLessThan(60);
    expect(scoped.getRateLimitStatus().availableTokens).toBe(client.getRateLimitStatus().availableTokens);
    expect(scoped.config.auth).not.toBe(client.config.auth);
    expect(scoped.config.auth).toBeInstanceOf(ApiKeyAuth);
    expect(scoped.config.logger).toBe(client.config.logger);
    expect(scoped.config.apiKey).toBe('');
    expect(client.config.apiKey).toBe('parent');
    expect(scoped).toBeInstanceOf(HuduClient);
  });

  it('interleaved bearer and api-key scopes do not cross', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, apiKey: 'parent' });
    const bearer = client.withAuth(new BearerTokenAuth('tok-X'));
    const keyed = client.withAuth('key-Y');
    await Promise.all([bearer.companies.get(1), keyed.companies.get(2)]);
    const headersFor = (path: string) => {
      const call = spy.calls.find((c) => new URL(c.url).pathname === path);
      return (call?.init.headers ?? {}) as Record<string, string>;
    };
    expect(headersFor('/api/v1/companies/1')['Authorization']).toBe('Bearer tok-X');
    expect(headersFor('/api/v1/companies/1')['x-api-key']).toBeUndefined();
    expect(headersFor('/api/v1/companies/2')['x-api-key']).toBe('key-Y');
    expect(headersFor('/api/v1/companies/2')['Authorization']).toBeUndefined();
  });

  it('withAuth on a scoped client replaces the credential', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, apiKey: 'parent' });
    const chained = client.withAuth('A').withAuth('B');
    await chained.companies.get(1);
    expect(headersOf(spy)['x-api-key']).toBe('B');
    expect(client.withAuth('A')).toBeInstanceOf(HuduClient);
  });

  it('withAuth issues no request at scope time', () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    expectRequests(spy, []);
    const client = new HuduClient({ baseUrl: BASE, apiKey: 'parent' });
    const scoped = client.withAuth('key-A');
    expect(scoped).toBeInstanceOf(HuduClient);
    expect(scoped.config.auth).toBeInstanceOf(ApiKeyAuth);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('fail-closed configuration', () => {
  afterEach(() => clearFetch());

  it('rejects neither credential and sends nothing', () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    expect(() => new HuduClient({ baseUrl: BASE })).toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('rejects both credentials and sends nothing', () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    expect(() => new HuduClient({ baseUrl: BASE, apiKey: 'k', auth: new BearerTokenAuth('t') }))
      .toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('rejects a blank apiKey', () => {
    expect(() => resolveConfig({ baseUrl: BASE, apiKey: '   ' })).toThrow(HuduConfigError);
  });

  it('rejects a non-string apiKey', () => {
    expect(() => resolveConfig({ baseUrl: BASE, apiKey: 42 as never })).toThrow(HuduConfigError);
  });

  it('accepts a blank apiKey when auth is set (a blank key counts as absent)', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, apiKey: '', auth: new BearerTokenAuth('t') });
    expect(client.config.apiKey).toBe('');
    await client.companies.get(1);
    expect(headersOf(spy)['Authorization']).toBe('Bearer t');
  });

  it('reports CONFIG_ERROR for every construction-time refusal', () => {
    const cases: (() => unknown)[] = [
      () => resolveConfig({ baseUrl: BASE }),
      () => resolveConfig({ baseUrl: BASE, apiKey: 'k', auth: new BearerTokenAuth('t') }),
      () => resolveConfig({ baseUrl: BASE, apiKey: '' }),
      () => resolveConfig({ baseUrl: BASE, apiKey: 42 as never }),
      () => resolveConfig({ baseUrl: BASE, apiKey: 42 as never, auth: new BearerTokenAuth('t') }),
    ];
    for (const run of cases) {
      try {
        run();
        throw new Error('expected a HuduConfigError');
      } catch (err) {
        expect(err).toBeInstanceOf(HuduConfigError);
        expect((err as HuduConfigError).code).toBe('CONFIG_ERROR');
        expect((err as HuduConfigError).retryable).toBe(false);
      }
    }
  });

  it('built-in constructors refuse blank credentials', () => {
    expect(() => new ApiKeyAuth('')).toThrow(HuduConfigError);
    expect(() => new ApiKeyAuth('  ')).toThrow(HuduConfigError);
    expect(() => new ApiKeyAuth(42 as never)).toThrow(HuduConfigError);
    expect(() => new BearerTokenAuth('')).toThrow(HuduConfigError);
    expect(() => new BearerTokenAuth(42 as never)).toThrow(HuduConfigError);
    expect(() => new HeaderAuth({})).toThrow(HuduConfigError);
    expect(() => new HeaderAuth({ 'x-k': '' })).toThrow(HuduConfigError);
    expect(() => new HeaderAuth(undefined as never)).toThrow(HuduConfigError);
  });

  it('withAuth refuses an empty string and a non-strategy', () => {
    const client = new HuduClient({ baseUrl: BASE, apiKey: 'k' });
    expect(() => client.withAuth('')).toThrow(HuduConfigError);
    expect(() => client.withAuth({} as never)).toThrow(HuduConfigError);
    expect(() => client.withAuth({ name: 'x' } as never)).toThrow(HuduConfigError);
    expect(() => client.withAuth(undefined as never)).toThrow(HuduConfigError);
  });

  it('an invalid auth shape at construction is rejected', () => {
    expect(() => resolveConfig({ baseUrl: BASE, auth: {} as never })).toThrow(HuduConfigError);
    expect(() => resolveConfig({ baseUrl: BASE, auth: { name: 'x' } as never })).toThrow(HuduConfigError);
    expect(() => resolveConfig({ baseUrl: BASE, auth: 'nope' as never })).toThrow(HuduConfigError);
    expect(() => resolveConfig({ baseUrl: BASE, auth: { name: '', headers: () => ({ 'x-k': 'v' }) } as never }))
      .toThrow(HuduConfigError);
  });

  it('a hand-built ResolvedConfig with no auth fails closed with AuthError, not a TypeError', async () => {
    // Reachable from JS (or a cast): `HttpClient`, `ResolvedConfig` and `resolveConfig` are all public
    // barrel exports. Both the audit path and the header-build path read the strategy, so this must be
    // ONE AuthError with no request on the wire.
    const spy = stubFetchAny({ baseUrl: BASE });
    const handBuilt = {
      ...resolveConfig({ baseUrl: BASE, apiKey: 'k' }),
      auth: undefined,
    } as unknown as ResolvedConfig;
    const http = new HttpClient(handBuilt);
    const err = await http.request({ method: 'GET', path: '/companies' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthError);
    expect(err).not.toBeInstanceOf(TypeError);
    const authError = err as AuthError;
    expect(authError.code).toBe('AUTH_ERROR');
    expect(authError.category).toBe('auth');
    expect(authError.retryable).toBe(false);
    expect(authError.message).toBe('no auth strategy is configured');
    expect(spy.calls).toHaveLength(0);
  });

  it('a dry run on a config with no auth also fails closed, and sends nothing', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    const handBuilt = {
      ...resolveConfig({ baseUrl: BASE, apiKey: 'k' }),
      auth: undefined,
    } as unknown as ResolvedConfig;
    const http = new HttpClient(handBuilt);
    await expect(http.request({ method: 'GET', path: '/companies', dryRun: true }))
      .rejects.toBeInstanceOf(AuthError);
    expect(spy.calls).toHaveLength(0);
  });

  it('isAuthStrategy accepts only the documented shape', () => {
    expect(isAuthStrategy(undefined)).toBe(false);
    expect(isAuthStrategy(null)).toBe(false);
    expect(isAuthStrategy('strategy')).toBe(false);
    expect(isAuthStrategy({})).toBe(false);
    expect(isAuthStrategy({ name: 'x' })).toBe(false);
    expect(isAuthStrategy({ name: '', headers: () => ({}) })).toBe(false);
    expect(isAuthStrategy({ name: 'x', headers: 'no' })).toBe(false);
    expect(isAuthStrategy({ name: 'x', headers: () => ({ 'x-k': 'v' }) })).toBe(true);
    expect(isAuthStrategy(new ApiKeyAuth('k'))).toBe(true);
  });
});

describe('tokens never appear in logs or audit events', () => {
  afterEach(() => clearFetch());

  it('the request log line contains no credential', async () => {
    stubFetch(() => json({}), { baseUrl: BASE });
    const debug = vi.fn();
    const warn = vi.fn();
    const logger: Logger = { debug, info: vi.fn(), warn, error: vi.fn() };
    const client = new HuduClient({ baseUrl: BASE, auth: new BearerTokenAuth('SUPERSECRET-TOKEN'), logger });
    await client.companies.get(1);
    expect(debug.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify([...debug.mock.calls, ...warn.mock.calls])).not.toContain('SUPERSECRET-TOKEN');
  });

  it('audit events contain no credential and mask credential-shaped fields', async () => {
    stubFetch(() => json({}), { baseUrl: BASE });
    const events: { query?: Record<string, unknown> }[] = [];
    const http = httpFor({ auth: new BearerTokenAuth('SECRET'), onAudit: (e: unknown) => events.push(e as { query?: Record<string, unknown> }) });
    await http.request({ method: 'GET', path: '/companies', query: { authorization: 'Bearer SECRET', bearer: 'SECRET', page: 2 } });
    expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(events[0]?.query?.authorization).toBe(REDACTED);
    expect(events[0]?.query?.bearer).toBe(REDACTED);
    expect(events[0]?.query?.page).toBe(2);
  });

  it('a strategy-declared secret header is masked in an audit event', async () => {
    stubFetch(() => json({}), { baseUrl: BASE });
    const events: { query?: Record<string, unknown> }[] = [];
    const http = httpFor({
      auth: new HeaderAuth({ 'x-tenant-key': 'TENANT-SECRET' }),
      onAudit: (e: unknown) => events.push(e as { query?: Record<string, unknown> }),
    });
    await http.request({ method: 'GET', path: '/companies', query: { 'x-tenant-key': 'TENANT-SECRET' } });
    expect(JSON.stringify(events)).not.toContain('TENANT-SECRET');
    expect(events[0]?.query?.['x-tenant-key']).toBe(REDACTED);
  });

  it('a resolver error text never reaches the thrown error', async () => {
    stubFetch(() => json({}), { baseUrl: BASE });
    const strategy: AuthStrategy = {
      name: 'vault',
      headers() {
        throw new Error('invalid token SUPERSECRET');
      },
    };
    const client = new HuduClient({ baseUrl: BASE, auth: strategy });
    const err = await client.companies.get(1).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthError);
    const authError = err as AuthError;
    expect(authError.message).not.toContain('SUPERSECRET');
    expect(JSON.stringify(authError)).not.toContain('SUPERSECRET');
    expect(authError.code).toBe('AUTH_ERROR');
    expect(authError.category).toBe('auth');
    expect(authError.retryable).toBe(false);
    expect(authError.httpStatus).toBeUndefined();
    expect(authError.suggestedAction).toContain('headers(ctx)');
    expect(authError.message).toContain('Auth strategy "vault" did not produce usable credential headers');
  });

  it('redact() masks bearer, jwt, auth_header and strategy-declared names', () => {
    expect(redact({ bearer: 'x' })).toEqual({ bearer: REDACTED });
    expect(redact({ jwt: 'x' })).toEqual({ jwt: REDACTED });
    expect(redact({ auth_header: 'x' })).toEqual({ auth_header: REDACTED });
    expect(redact({ proxy_authorization: 'x' })).toEqual({ proxy_authorization: REDACTED });
    expect(redact({ x_api_key: 'x' })).toEqual({ x_api_key: REDACTED });
    expect(redact({ 'x-tenant-token': 'v' }, ['x-tenant-token'])).toEqual({ 'x-tenant-token': REDACTED });
    expect(isCredentialKey('keywords')).toBe(false);
  });

  it('the transport dry-run marker carries no credential and has exactly five keys', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    const http = httpFor({ auth: new BearerTokenAuth('SECRET') });
    const marker = (await http.request({ method: 'POST', path: '/companies', dryRun: true })) as unknown as Record<string, unknown>;
    expect(Object.keys(marker).sort()).toEqual(['__dryRun', 'method', 'path', 'simulated', 'url']);
    expect(JSON.stringify(marker)).not.toContain('SECRET');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('retry semantics', () => {
  afterEach(() => clearFetch());

  it('the credential is re-resolved on each attempt', async () => {
    const { strategy, count } = countingStrategy(['tok-1', 'tok-2']);
    let n = 0;
    const spy = stubFetch(() => (++n === 1 ? json({ error: 'boom' }, 500) : json({ company: { id: 1 } })));
    const client = new HuduClient({ baseUrl: BASE, auth: strategy, maxRetries: 3 });
    await client.companies.get(1);
    expect(spy.calls).toHaveLength(2);
    expect(headersOf(spy, 0)['x-api-key']).toBe('tok-1');
    expect(headersOf(spy, 1)['x-api-key']).toBe('tok-2');
    expect(count()).toBe(2);
  });

  it('a sync strategy is resolved exactly once for a single-attempt call', async () => {
    const first = countingStrategy(['tok-1']);
    stubFetch(() => json({}), { baseUrl: BASE });
    const client = new HuduClient({ baseUrl: BASE, auth: first.strategy });
    await client.companies.get(1);
    expect(first.count()).toBe(1);
    expect(first.contexts[0]?.attempt).toBe(0);
    clearFetch();

    const post = countingStrategy(['tok-1']);
    stubFetch(() => json({ error: 'boom' }, 500), { baseUrl: BASE });
    const postClient = new HuduClient({ baseUrl: BASE, auth: post.strategy, maxRetries: 3 });
    await expect(postClient.companies.create({ name: 'Acme' })).rejects.toBeInstanceOf(Error);
    // POST is never retried, so the resolver ran exactly once.
    expect(post.count()).toBe(1);
  });

  it('a resolver failure is not retried', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    let attempts = 0;
    const strategy: AuthStrategy = {
      name: 'throwing',
      headers() {
        attempts += 1;
        throw new Error('vault is down');
      },
    };
    const client = new HuduClient({ baseUrl: BASE, auth: strategy, maxRetries: 3 });
    await expect(client.companies.get(1)).rejects.toBeInstanceOf(AuthError);
    expect(spy.calls).toHaveLength(0);
    expect(attempts).toBe(1);
  });

  it('a 401 is not retried and is an UnauthorizedError with category auth', async () => {
    const spy = stubFetch(() => json({ error: 'bad key' }, 401), { baseUrl: BASE });
    const { strategy, count } = countingStrategy(['tok-1']);
    const client = new HuduClient({ baseUrl: BASE, auth: strategy, maxRetries: 3 });
    const err = await client.companies.get(1).then(
      () => undefined,
      (e: unknown) => e as UnauthorizedError,
    );
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.category).toBe('auth');
    expect(err.httpStatus).toBe(401);
    expect(spy.calls).toHaveLength(1);
    expect(count()).toBe(1);
  });
});

describe('dry run sends nothing', () => {
  afterEach(() => clearFetch());

  it('a dry run calls no resolver and sends no request', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    expectRequests(spy, []);
    const { strategy, count } = countingStrategy(['tok-1']);
    const client = new HuduClient({ baseUrl: BASE, auth: strategy });
    const result = await client.companies.create({ name: 'Acme' }, { dryRun: true });
    expect(result.simulated).toBe(true);
    expect(spy.calls).toHaveLength(0);
    expect(count()).toBe(0);
  });

  it('a dry run works with a strategy that would fail', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    const strategy: AuthStrategy = {
      name: 'always-fails',
      headers() {
        throw new Error('no credential available');
      },
    };
    const client = new HuduClient({ baseUrl: BASE, auth: strategy });
    const result = await client.companies.create({ name: 'Acme' }, { dryRun: true });
    expect(result.simulated).toBe(true);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('legacy auth helpers stay byte-compatible', () => {
  it('API_KEY_HEADER, buildAuthHeaders and withAuth are unchanged', () => {
    expect(API_KEY_HEADER).toBe('x-api-key');
    expect(buildAuthHeaders('k')).toEqual({ 'x-api-key': 'k' });
    expect(withAuth(undefined, 'k')).toEqual({ 'x-api-key': 'k' });
    const caller = { 'X-Custom': 'yes' };
    expect(withAuth(caller, 'k')).toEqual({ 'x-api-key': 'k', 'X-Custom': 'yes' });
    expect(caller).toEqual({ 'X-Custom': 'yes' });
  });

  it('the built-ins trim and copy defensively', () => {
    expect(new ApiKeyAuth('  k  ').headers()).toEqual({ 'x-api-key': 'k' });
    expect(new ApiKeyAuth('k').name).toBe('api-key');
    expect(new ApiKeyAuth('k').secretHeaders).toEqual(['x-api-key']);
    expect(new BearerTokenAuth('  t  ').headers()).toEqual({ Authorization: 'Bearer t' });
    expect(new BearerTokenAuth('t').name).toBe('bearer-token');
    expect(new BearerTokenAuth('t').secretHeaders).toEqual(['authorization']);

    const header = new HeaderAuth({ 'x-tenant-key': 'v' }, { name: 'tenant' });
    expect(header.name).toBe('tenant');
    expect(header.secretHeaders).toEqual(['x-tenant-key']);
    const first = header.headers();
    expect(first).toEqual({ 'x-tenant-key': 'v' });
    expect(header.headers()).not.toBe(first);
    first['x-tenant-key'] = 'mutated';
    expect(header.headers()).toEqual({ 'x-tenant-key': 'v' });

    const narrowed = new HeaderAuth({ 'x-tenant-key': 'v', 'x-trace': 't' }, { secretHeaders: ['x-tenant-key'] });
    expect(narrowed.name).toBe('header');
    expect(narrowed.secretHeaders).toEqual(['x-tenant-key']);
  });
});

describe('an illegal HTTP header name or value fails closed before any request (G1)', () => {
  afterEach(() => clearFetch());

  /** Run a request and hand back the thrown error, failing the test when nothing was thrown. */
  async function thrown(pending: Promise<unknown>): Promise<unknown> {
    return pending.then(
      () => { throw new Error('expected the request to fail closed'); },
      (err: unknown) => err,
    );
  }

  /** A custom strategy (the issue #23 extension point) returning one fixed map. */
  function strategyReturning(headers: Record<string, string>): AuthStrategy {
    return { name: 'custom', headers: () => headers };
  }

  /** Everything the SDK logged or audited during the call, flattened for a substring scan. */
  function capturing(): { logger: Logger; audit: unknown[]; sink: string[] } {
    const sink: string[] = [];
    const push = (message: string) => { sink.push(message); };
    const audit: unknown[] = [];
    return { logger: { debug: push, info: push, warn: push, error: push }, audit, sink };
  }

  /**
   * The credential must not surface in the error, its stack, or anything the SDK emitted. An illegal
   * header value is exactly the case where native `fetch()` would otherwise echo it verbatim.
   */
  function expectAuthFailureWithoutLeak(err: unknown, secret: string, seen: { audit: unknown[]; sink: string[] }): void {
    expect(err).toBeInstanceOf(AuthError);
    const authError = err as AuthError;
    expect(authError.code).toBe('AUTH_ERROR');
    expect(authError.category).toBe('auth');
    expect(authError.retryable).toBe(false);
    expect(authError.message).toContain('Auth strategy "');
    expect(authError.message).toContain('did not produce usable credential headers');
    expect(authError.message).not.toContain(secret);
    expect(String(authError.stack)).not.toContain(secret);
    expect(seen.sink.join('\n')).not.toContain(secret);
    expect(JSON.stringify(seen.audit)).not.toContain(secret);
  }

  it('T1 an ApiKeyAuth whose key carries an interior newline is refused, and nothing is sent', async () => {
    const VALUE = 'abc\ndef';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const http = httpFor({ auth: new ApiKeyAuth(VALUE), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectAuthFailureWithoutLeak(err, VALUE, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('T2 a BearerTokenAuth whose token carries CRLF is refused, and nothing is sent', async () => {
    const VALUE = 'tok\r\nX-Injected: 1';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const http = httpFor({ auth: new BearerTokenAuth(VALUE), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectAuthFailureWithoutLeak(err, VALUE, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('T3 a custom strategy returning an illegal header VALUE is refused, and nothing is sent', async () => {
    const VALUE = 'a\nb';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const http = httpFor({ auth: strategyReturning({ 'x-api-key': VALUE }), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectAuthFailureWithoutLeak(err, VALUE, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('T4 a custom strategy returning an illegal header NAME is refused, and nothing is sent', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const http = httpFor({ auth: strategyReturning({ 'x api key': 'v' }), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectAuthFailureWithoutLeak(err, 'x api key', seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('T4b a DEL character in the value and a separator name are both refused', async () => {
    const spy = stubFetchAny({ baseUrl: BASE });
    const cases: Record<string, string>[] = [
      { 'x-api-key': 'a\u007fb' }, { 'x:api': 'v' }, { 'x\tk': 'v' }, { 'x-api-key': 'a\u001bb' },
    ];
    for (const headers of cases) {
      const http = httpFor({ auth: strategyReturning(headers) });
      await expect(http.request({ method: 'GET', path: '/companies' })).rejects.toBeInstanceOf(AuthError);
    }
    expect(spy.calls).toHaveLength(0);
  });

  it('T5 a caller-supplied header with a control character never leaks through the network error', async () => {
    const VALUE = 'trace\nCALLER-SUPERSECRET';
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    // Exactly what native fetch does with an illegal value: `Headers` throws a TypeError that echoes
    // the value verbatim. Reproduced here from the real undici error, not a hand-written string.
    spy.setHandler((_url, init) => {
      new Headers(init.headers as Record<string, string>);
      return json({});
    });
    const seen = capturing();
    const http = httpFor({ apiKey: 'k', logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies', headers: { 'x-trace': VALUE } }));
    expect(err).toBeInstanceOf(HuduNetworkError);
    const netErr = err as HuduNetworkError;
    expect(netErr.message).toBe('Network error: an invalid HTTP header was produced; a header value is not a legal HTTP field value');
    expect(netErr.message).not.toContain(VALUE);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(VALUE);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('CALLER-SUPERSECRET');
    expect(seen.sink.join('\n')).not.toContain(VALUE);
    expect(JSON.stringify(seen.audit)).not.toContain(VALUE);
    // The request really did reach fetch: the guard is the network-error wrap, not a pre-flight refusal.
    expect(spy.calls).toHaveLength(1);
    expect(headersOf(spy)['x-trace']).toBe(VALUE);
  });

  it('T6 legal apiKey, bearer and custom headers still reach the wire unchanged', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    const http = httpFor({ apiKey: 'key-A' });
    await http.request({ method: 'GET', path: '/companies' });
    await httpFor({ auth: new BearerTokenAuth('tok-A') }).request({ method: 'GET', path: '/companies' });
    await httpFor({ auth: strategyReturning({ 'x-tenant-key': 'tenant 1', 'x-trace': 'a.b-c_d~e!f' }) })
      .request({ method: 'GET', path: '/companies' });
    expect(spy.calls).toHaveLength(3);
    expect(headersOf(spy, 0)['x-api-key']).toBe('key-A');
    expect(headersOf(spy, 1)['Authorization']).toBe('Bearer tok-A');
    expect(headersOf(spy, 2)['x-tenant-key']).toBe('tenant 1');
    expect(headersOf(spy, 2)['x-trace']).toBe('a.b-c_d~e!f');
  });
});

describe("reading a strategy's produced header map fails closed, like the call itself (G1-R1)", () => {
  afterEach(() => clearFetch());

  /** Run a request and hand back the thrown error, failing the test when nothing was thrown. */
  async function thrown(pending: Promise<unknown>): Promise<unknown> {
    return pending.then(
      () => { throw new Error('expected the request to fail closed'); },
      (err: unknown) => err,
    );
  }

  /** Everything the SDK logged or audited during the call, flattened for a substring scan. */
  function capturing(): { logger: Logger; audit: unknown[]; sink: string[] } {
    const sink: string[] = [];
    const push = (message: string) => { sink.push(message); };
    const audit: unknown[] = [];
    return { logger: { debug: push, info: push, warn: push, error: push }, audit, sink };
  }

  /**
   * A getter or a Proxy trap that throws while the map is read used to propagate the RAW error — its
   * message and stack — past every AuthError builder. The only acceptable outcome now is the same
   * credential-free `AuthError` the direct `headers(ctx)` call produces.
   */
  function expectReadFailureWithoutLeak(err: unknown, secret: string, seen: { audit: unknown[]; sink: string[] }): void {
    expect(err).toBeInstanceOf(AuthError);
    const authError = err as AuthError;
    expect(authError.code).toBe('AUTH_ERROR');
    expect(authError.category).toBe('auth');
    expect(authError.retryable).toBe(false);
    expect(authError.message).toContain('Auth strategy "');
    expect(authError.message).toContain('did not produce usable credential headers');
    expect(authError.message).not.toContain(secret);
    expect(String(authError.stack)).not.toContain(secret);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(secret);
    expect(seen.sink.join('\n')).not.toContain(secret);
    expect(JSON.stringify(seen.audit)).not.toContain(secret);
  }

  /** A strategy (the issue #23 extension point) returning one fixed value, throwing on every read. */
  function strategyReturning(produced: unknown, name = 'custom'): AuthStrategy {
    return { name, headers: () => produced as Record<string, string> };
  }

  it('P1 a throwing getter on the returned map is refused, and nothing is sent', async () => {
    const SECRET = 'LEAK-GETTER-8f3c1d';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const map = {
      get ['x-api-key'](): string {
        throw new Error(`vault read failed while loading ${SECRET}`);
      },
    };
    const http = httpFor({ auth: strategyReturning(map), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectReadFailureWithoutLeak(err, SECRET, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('P2 a Proxy whose ownKeys trap throws is refused, and nothing is sent', async () => {
    const SECRET = 'LEAK-OWNKEYS-2b7e04';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const map = new Proxy({}, {
      ownKeys(): string[] { throw new Error(`key enumeration failed, ${SECRET}`); },
    });
    const http = httpFor({ auth: strategyReturning(map), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectReadFailureWithoutLeak(err, SECRET, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('P3 a Proxy whose get trap throws is refused, and nothing is sent', async () => {
    const SECRET = 'LEAK-PROXYGET-5a19c2';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const map = new Proxy({}, {
      get(): string { throw new Error(`value read failed, ${SECRET}`); },
    });
    const http = httpFor({ auth: strategyReturning(map), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectReadFailureWithoutLeak(err, SECRET, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('P4 a Proxy whose ownKeys trap returns duplicate keys is refused, and nothing is sent', async () => {
    const SECRET = 'LEAK-DUPKEY-c40d77';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    // `Object.keys` raises a real TypeError ('trap returned duplicate entries') on this shape; the
    // engine message carries no credential, so the meaningful assertions here are the substituted
    // AuthError, its fixed message, and zero requests.
    const map = new Proxy({}, {
      ownKeys: (): string[] => ['x-api-key', 'x-api-key'],
      getOwnPropertyDescriptor: () => ({ value: SECRET, enumerable: true, configurable: true, writable: true }),
    });
    const http = httpFor({ auth: strategyReturning(map), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectReadFailureWithoutLeak(err, SECRET, seen);
    expect((err as AuthError).message).not.toContain('duplicate entries');
    expect(spy.calls).toHaveLength(0);
  });

  it('P5 regression: honest sync and async strategies still reach the wire unchanged', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    await httpFor({ auth: strategyReturning({ 'x-tenant-key': 'tenant 1' }) })
      .request({ method: 'GET', path: '/companies' });
    await httpFor({ auth: { name: 'async', headers: async () => ({ 'x-api-key': 'async-key' }) } })
      .request({ method: 'GET', path: '/companies' });
    expect(spy.calls).toHaveLength(2);
    expect(headersOf(spy, 0)['x-tenant-key']).toBe('tenant 1');
    expect(headersOf(spy, 1)['x-api-key']).toBe('async-key');
  });
});

describe('a credential-free map can never be returned, and values are printable ASCII (G1-R3 / G1-R2)', () => {
  afterEach(() => clearFetch());

  /** Run a request and hand back the thrown error, failing the test when nothing was thrown. */
  async function thrown(pending: Promise<unknown>): Promise<unknown> {
    return pending.then(
      () => { throw new Error('expected the request to fail closed'); },
      (err: unknown) => err,
    );
  }

  /** A custom strategy (the issue #23 extension point) returning one fixed value, untyped on purpose. */
  function strategyReturning(produced: unknown, name = 'custom'): AuthStrategy {
    return { name, headers: () => produced as Record<string, string> };
  }

  /** Everything the SDK logged or audited during the call, flattened for a substring scan. */
  function capturing(): { logger: Logger; audit: unknown[]; sink: string[] } {
    const sink: string[] = [];
    const push = (message: string) => { sink.push(message); };
    const audit: unknown[] = [];
    return { logger: { debug: push, info: push, warn: push, error: push }, audit, sink };
  }

  /** The planted value must not surface in the error, its stack, its own properties, or any output. */
  function expectFailClosedWithoutLeak(err: unknown, secret: string, seen: { audit: unknown[]; sink: string[] }): void {
    expect(err).toBeInstanceOf(AuthError);
    const authError = err as AuthError;
    expect(authError.code).toBe('AUTH_ERROR');
    expect(authError.category).toBe('auth');
    expect(authError.retryable).toBe(false);
    expect(authError.message).toContain('Auth strategy "');
    expect(authError.message).toContain('did not produce usable credential headers');
    expect(authError.message).not.toContain(secret);
    expect(String(authError.stack)).not.toContain(secret);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(secret);
    expect(Object.getOwnPropertyNames(authError).join('|')).not.toContain(secret);
    expect(seen.sink.join('\n')).not.toContain(secret);
    expect(JSON.stringify(seen.audit)).not.toContain(secret);
  }

  // Q1: `JSON.parse` creates `__proto__` as an OWN key, so the map is non-empty, the name is a legal
  // `tchar` sequence, and `out[key] = value` used to set the prototype instead of adding a key. The
  // function then returned an EMPTY map and the request went out with no credential at all.
  it('Q1 a strategy returning JSON.parse(\'{"__proto__": ...}\') is refused, and nothing is sent', async () => {
    const PLANTED = 'PROTO-EMPTY-9c1f2a';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const http = httpFor({
      auth: strategyReturning(JSON.parse(`{"__proto__":"${PLANTED}"}`) as Record<string, string>),
      logger: seen.logger,
      onAudit: (e: unknown) => seen.audit.push(e),
    });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectFailClosedWithoutLeak(err, PLANTED, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('Q2 a Proxy whose ownKeys trap returns only __proto__ is refused, and nothing is sent', async () => {
    const PLANTED = 'PROXY-PROTO-4b7d10';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    // A null-prototype target keeps the proxy invariants happy while the traps make the map look
    // exactly like the one `JSON.parse` produces.
    const map = new Proxy(Object.create(null) as Record<string, string>, {
      ownKeys: (): string[] => ['__proto__'],
      getOwnPropertyDescriptor: () => ({ value: PLANTED, enumerable: true, configurable: true, writable: true }),
      get: (): string => PLANTED,
    });
    const http = httpFor({ auth: strategyReturning(map), logger: seen.logger, onAudit: (e: unknown) => seen.audit.push(e) });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectFailClosedWithoutLeak(err, PLANTED, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('Q3 an emoji above 0xFF in the value is refused, and nothing is sent', async () => {
    const PLANTED = 'KEY-\u{1f511}-SECRET';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const http = httpFor({
      auth: strategyReturning({ 'x-api-key': PLANTED }),
      logger: seen.logger,
      onAudit: (e: unknown) => seen.audit.push(e),
    });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectFailClosedWithoutLeak(err, PLANTED, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('Q4 a Latin-1 byte in the value is refused, and nothing is sent', async () => {
    const PLANTED = 'caf\u00e9-SECRET';
    const spy = stubFetchAny({ baseUrl: BASE });
    const seen = capturing();
    const http = httpFor({
      auth: strategyReturning({ 'x-api-key': PLANTED }),
      logger: seen.logger,
      onAudit: (e: unknown) => seen.audit.push(e),
    });
    const err = await thrown(http.request({ method: 'GET', path: '/companies' }));
    expectFailClosedWithoutLeak(err, PLANTED, seen);
    expect(spy.calls).toHaveLength(0);
  });

  it('Q5 regression: printable-ASCII credentials still reach the wire unchanged', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: BASE });
    await httpFor({ auth: strategyReturning({ 'x-tenant-key': 'tenant 1', 'x-trace': 'a.b-c_d~e!f' }) })
      .request({ method: 'GET', path: '/companies' });
    await httpFor({ auth: new ApiKeyAuth('key-A') }).request({ method: 'GET', path: '/companies' });
    await httpFor({ auth: new BearerTokenAuth('tok-A') }).request({ method: 'GET', path: '/companies' });
    expect(spy.calls).toHaveLength(3);
    expect(headersOf(spy, 0)['x-tenant-key']).toBe('tenant 1');
    expect(headersOf(spy, 0)['x-trace']).toBe('a.b-c_d~e!f');
    expect(headersOf(spy, 1)['x-api-key']).toBe('key-A');
    expect(headersOf(spy, 2)['Authorization']).toBe('Bearer tok-A');
  });
});
