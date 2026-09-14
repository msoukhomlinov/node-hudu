/**
 * HuduClient construction and resource wiring tests.
 */
import { describe, it, expect } from 'vitest';
import { HuduClient } from '../src/client.js';
import { ApiKeyAuth, BearerTokenAuth, HeaderAuth } from '../src/auth.js';
import { HuduConfigError } from '../src/errors.js';
import { clearFetch, expectRequests, stubFetchAny, type FetchSpy } from './helpers.js';

const RESOURCES = [
  'companies', 'articles', 'assetLayouts', 'assetPasswords', 'assets', 'expirations',
  'exports', 'flagTypes', 'flags', 'folders', 'groups', 'ipAddresses', 'labelTypes',
  'labels', 'lists', 'magicDash', 'matchers', 'networks', 'passwordFolders', 'photos',
  'procedureTasks', 'procedures', 'publicPhotos', 'rackStorageItems', 'rackStorages',
  'relations', 's3Exports', 'uploads', 'users', 'vlanZones', 'vlans', 'websites',
  'apiInfo', 'activityLogs', 'cards',
] as const;

function makeClient() {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'key' });
}

describe('HuduClient', () => {
  // Strict: the client constructor must not make a single request, so ANY request fails the test.
  let spy: FetchSpy;
  beforeEach(() => {
    spy = stubFetchAny({ baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, []);
  });
  afterEach(() => clearFetch());

  it('resolves and exposes the config', () => {
    const c = makeClient();
    expect(c.config.baseUrl).toBe('https://hudu.example.com');
    expect(c.config.basePath).toBe('/api/v1');
    expect(c.config.apiKey).toBe('key');
  });

  it('wires all 35 resource clients', () => {
    const c = makeClient();
    for (const name of RESOURCES) {
      const r = (c as unknown as Record<string, unknown>)[name];
      expect(r, `missing resource: ${name}`).toBeDefined();
    }
    expect(RESOURCES).toHaveLength(35);
  });

  it('throws HuduConfigError for an invalid baseUrl', () => {
    expect(() => new HuduClient({ baseUrl: 'ftp://bad', apiKey: 'k' })).toThrow(HuduConfigError);
  });

  it('throws HuduConfigError for a missing apiKey', () => {
    expect(() => new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: '' })).toThrow(HuduConfigError);
  });
});

describe('HuduClient.withAuth — a scoped client (issue #23)', () => {
  let spy: FetchSpy;
  beforeEach(() => {
    spy = stubFetchAny({ baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, []);
  });
  afterEach(() => clearFetch());

  it('returns a real HuduClient with all 35 resources and the same own-key shape', () => {
    const parent = makeClient();
    const scoped = parent.withAuth('scoped-key');
    expect(scoped).toBeInstanceOf(HuduClient);
    for (const name of RESOURCES) {
      expect((scoped as unknown as Record<string, unknown>)[name], `missing resource: ${name}`).toBeDefined();
    }
    // 35 resources + operations + config + http (mirrors the parent's own-key shape).
    expect(Object.keys(scoped).length).toBe(Object.keys(parent).length);
    expect(Object.keys(scoped).length).toBe(38);
    expect(scoped.operations).toBeDefined();
  });

  it('issues no request and keeps the parent untouched', () => {
    const parent = makeClient();
    const scoped = parent.withAuth('scoped-key');
    expect(scoped).not.toBe(parent);
    expect(scoped.config.apiKey).toBe('');
    expect(parent.config.apiKey).toBe('key');
    expect(parent.config.auth).toBeInstanceOf(ApiKeyAuth);
    expect(scoped.config.auth).toBeInstanceOf(ApiKeyAuth);
    expect(scoped.config.auth).not.toBe(parent.config.auth);
    expect(scoped.config.baseUrl).toBe(parent.config.baseUrl);
    expect(scoped.config.logger).toBe(parent.config.logger);
    // The strict empty plan in beforeEach proves the scope made no request.
    expect(spy.calls).toHaveLength(0);
  });

  it('shares the parent transport state and declines to nest credentials', () => {
    const parent = new HuduClient({
      baseUrl: 'https://hudu.example.com',
      apiKey: 'key',
      rateLimit: { perMinute: 60, burst: 2 },
    });
    const first = parent.withAuth(new HeaderAuth({ 'x-tenant-key': 't1' }));
    const second = first.withAuth(new BearerTokenAuth('tok'));
    expect(second.config.auth.name).toBe('bearer-token');
    expect(second.getRateLimitStatus().burst).toBe(parent.getRateLimitStatus().burst);
    expect(second.getRateLimitStatus().availableTokens).toBe(parent.getRateLimitStatus().availableTokens);
    // Nothing is mutated on the way down.
    expect(parent.config.auth.name).toBe('api-key');
    expect(first.config.auth.name).toBe('header');
  });

  it('throws HuduConfigError for an empty key or a non-strategy', () => {
    const c = makeClient();
    expect(() => c.withAuth('')).toThrow(HuduConfigError);
    expect(() => c.withAuth('   ')).toThrow(HuduConfigError);
    expect(() => c.withAuth({} as never)).toThrow(HuduConfigError);
    const err = (() => {
      try {
        c.withAuth('');
      } catch (e) {
        return e as HuduConfigError;
      }
      return undefined;
    })();
    expect(err?.code).toBe('CONFIG_ERROR');
    expect(err?.category).toBe('validation');
    expect(spy.calls).toHaveLength(0);
  });
});
