/**
 * HTTP transport tests (HttpClient.request) using a mocked global fetch.
 */
import { describe, it, expect } from 'vitest';
import { HttpClient, unwrapByKey, unwrapList } from '../src/http.js';
import { resolveConfig } from '../src/config.js';
import { HuduNetworkError, RateLimitError, BadRequestError, NotFoundError, HuduError } from '../src/errors.js';
import { clearFetch, stubFetch, json, text, empty, type FetchSpy } from './helpers.js';

function makeClient(overrides: Record<string, unknown> = {}) {
  const cfg = resolveConfig({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'secret-key',
    ...overrides,
  });
  return new HttpClient(cfg);
}

describe('URL construction', () => {
  it('builds baseUrl + basePath + path + query and strips null/empty values', async () => {
    let spy: FetchSpy = stubFetch(() => json({}));
    const client = makeClient();
    await client.request<unknown>({
      method: 'GET',
      path: '/companies',
      query: { search: 'acme', page: 1, tags: ['a', 'b'], empty: '', nil: null, undef: undefined },
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies?search=acme&page=1&tags=a&tags=b');
    clearFetch();

    // Custom basePath + no query
    spy = stubFetch(() => json({}));
    const client2 = makeClient({ basePath: '/api/v2' });
    await client2.request<unknown>({ method: 'GET', path: '/companies/5' });
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v2/companies/5');
    clearFetch();
  });

  it('omits the query string entirely when no query is provided or it is empty', async () => {
    const spy = stubFetch(() => json({}));
    const client = makeClient();
    await client.request<unknown>({ method: 'GET', path: '/companies' });
    await client.request<unknown>({ method: 'GET', path: '/companies', query: {} });
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies');
    expect(spy.calls[1].url).toBe('https://hudu.example.com/api/v1/companies');
    clearFetch();
  });
});

describe('headers and body', () => {
  it('sends the x-api-key header', async () => {
    const spy = stubFetch(() => json({}));
    const client = makeClient();
    await client.request<unknown>({ method: 'GET', path: '/companies' });
    const headers = spy.calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key');
    expect(headers['Accept']).toBe('application/json');
    clearFetch();
  });

  it('sends a JSON body with content-type', async () => {
    const spy = stubFetch(() => json({ company: { id: 1 } }));
    const client = makeClient();
    const res = await client.request<unknown>({ method: 'POST', path: '/companies', body: { name: 'Acme' } });
    const headers = spy.calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ name: 'Acme' }));
    expect(res).toEqual({ company: { id: 1 } });
    clearFetch();
  });

  it('does not set content-type when there is no body', async () => {
    const spy = stubFetch(() => json({}));
    const client = makeClient();
    await client.request<unknown>({ method: 'DELETE', path: '/companies/1' });
    const headers = spy.calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    clearFetch();
  });

  it('passes through extra headers', async () => {
    const spy = stubFetch(() => json({}));
    const client = makeClient();
    await client.request<unknown>({ method: 'GET', path: '/x', headers: { 'X-Custom': 'yes' } });
    const headers = spy.calls[0].init.headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('yes');
    clearFetch();
  });
});

describe('response handling', () => {
  it('resolves undefined for an empty 204 response', async () => {
    const spy = stubFetch(() => empty(204));
    const client = makeClient();
    await expect(client.request<unknown>({ method: 'DELETE', path: '/companies/1' })).resolves.toBeUndefined();
    expect(spy.calls).toHaveLength(1);
    clearFetch();
  });

  it('parses a JSON response body', async () => {
    stubFetch(() => json({ company: { id: 7 } }));
    const client = makeClient();
    const res = await client.request<unknown>({ method: 'GET', path: '/companies/7' });
    expect(res).toEqual({ company: { id: 7 } });
    clearFetch();
  });

  it('returns the raw string when JSON parsing fails', async () => {
    stubFetch(() => text('<html>not json</html>', 200));
    const client = makeClient();
    const res = await client.request<unknown>({ method: 'GET', path: '/companies/7' });
    expect(res).toBe('<html>not json</html>');
    clearFetch();
  });
});

describe('errors', () => {
  it('propagates an error from a non-2xx status', async () => {
    stubFetch(() => json({ error: 'not here' }, 404));
    const client = makeClient();
    await expect(client.request<unknown>({ method: 'GET', path: '/companies/999' })).rejects.toBeInstanceOf(NotFoundError);
    clearFetch();
    // different status
    stubFetch(() => json({}, 400));
    await expect(client.request<unknown>({ method: 'GET', path: '/companies/999' })).rejects.toBeInstanceOf(BadRequestError);
    clearFetch();
  });

  it('throws a HuduNetworkError on a network failure', async () => {
    stubFetch(() => { throw new TypeError('fetch failed'); });
    const client = makeClient();
    await expect(client.request<unknown>({ method: 'GET', path: '/companies' })).rejects.toBeInstanceOf(HuduNetworkError);
    clearFetch();
  });

  it('throws a HuduNetworkError on a timeout', async () => {
    stubFetch(() => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    const client = makeClient({ timeoutMs: 1000 });
    await expect(client.request<unknown>({ method: 'GET', path: '/companies' })).rejects.toMatchObject({
      name: 'HuduNetworkError',
    });
    clearFetch();
  });

  it('throws a RateLimitError when retries are exhausted on 429', async () => {
    const spy = stubFetch(() => json({ detail: 'rate' }, 429, { 'Retry-After': '5' }));
    const client = makeClient({ maxRetries: 0 });
    await expect(client.request<unknown>({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'RATE_LIMIT',
      status: 429,
      retryAfter: 5,
    });
    expect(spy.calls).toHaveLength(1);
    clearFetch();
  });
});

describe('retries', () => {
  it('retries a 429 and honours Retry-After, then succeeds', async () => {
    let n = 0;
    const spy = stubFetch(() => {
      n++;
      if (n === 1) return json({}, 429, { 'Retry-After': '0.01' });
      return json({ ok: true });
    });
    const client = makeClient({ maxRetries: 3 });
    const res = await client.request<unknown>({ method: 'GET', path: '/x' });
    expect(res).toEqual({ ok: true });
    expect(n).toBe(2);
    expect(spy.calls).toHaveLength(2);
    clearFetch();
  });

  it('retries a 5xx with backoff, then succeeds', async () => {
    let n = 0;
    const spy = stubFetch(() => {
      n++;
      if (n < 3) return json({}, 500);
      return json({ ok: true });
    });
    const client = makeClient({ maxRetries: 5 });
    const res = await client.request<unknown>({ method: 'GET', path: '/x' });
    expect(res).toEqual({ ok: true });
    expect(n).toBe(3);
    clearFetch();
  });

  it('does NOT retry a POST', async () => {
    let n = 0;
    const spy = stubFetch(() => {
      n++;
      return json({}, 500);
    });
    const client = makeClient({ maxRetries: 5 });
    await expect(client.request<unknown>({ method: 'POST', path: '/companies', body: {} })).rejects.toBeInstanceOf(HuduError);
    expect(n).toBe(1);
    expect(spy.calls).toHaveLength(1);
    clearFetch();
  });

  it('does NOT retry when retries are disabled', async () => {
    let n = 0;
    stubFetch(() => { n++; return json({}, 500); });
    const client = makeClient({ maxRetries: 0 });
    await expect(client.request<unknown>({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(HuduError);
    expect(n).toBe(1);
    clearFetch();
  });
});

describe('envelope helpers', () => {
  it('unwrapByKey extracts a keyed value', () => {
    expect(unwrapByKey<{ id: number }>({ company: { id: 1 } }, 'company')).toEqual({ id: 1 });
    expect(unwrapByKey<number>({ page: 2 }, 'page')).toBe(2);
  });
  it('unwrapByKey returns the record when the key is missing', () => {
    expect(unwrapByKey({ id: 1 }, 'nope')).toEqual({ id: 1 });
  });
  it('unwrapByKey returns {} for non-record data when a key is given', () => {
    const arr = [1, 2];
    expect(unwrapByKey(arr, 'x')).toEqual({});
  });
  it('unwrapByKey passes through data when no key is given', () => {
    const obj = { id: 1 };
    expect(unwrapByKey(obj, undefined)).toBe(obj);
  });
  it('unwrapList extracts a keyed array', () => {
    expect(unwrapList<number>({ ids: [1, 2, 3] }, 'ids')).toEqual([1, 2, 3]);
  });
  it('unwrapList returns data when it is already an array', () => {
    expect(unwrapList<number>([1, 2], 'anything')).toEqual([1, 2]);
  });
  it('unwrapList passes a bare array through unchanged', () => {
    expect(unwrapList<number>([5, 6], undefined)).toEqual([5, 6]);
    expect(unwrapList<number>([5, 6], 'items')).toEqual([5, 6]);
  });
  it('unwrapList extracts the keyed array when present', () => {
    expect(unwrapList<number>({ meta: 'x', items: [5, 6] }, 'items')).toEqual([5, 6]);
  });
  it('unwrapList returns [] when there is no array', () => {
    expect(unwrapList({ a: 1, b: 'c' }, 'nope')).toEqual([]);
  });
});

describe('resolveRedirect', () => {
  it('returns the Location URL for a 3xx redirect', async () => {
    const spy = stubFetch(() =>
      new Response(null, { status: 302, headers: { location: '/companies/acme' } }),
    );
    const client = makeClient();
    const url = await client.resolveRedirect('/companies/jump', { integration_slug: 'hudu' });
    expect(url).toBe('https://hudu.example.com/companies/acme');
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/jump?integration_slug=hudu');
    clearFetch();
  });

  it('returns the requested URL when the server responds 200', async () => {
    stubFetch(() => json({}));
    const client = makeClient();
    const url = await client.resolveRedirect('/companies/jump');
    expect(url).toBe('https://hudu.example.com/api/v1/companies/jump');
    clearFetch();
  });

  it('throws the mapped error on a non-2xx/3xx response', async () => {
    stubFetch(() => json({}, 404));
    const client = makeClient();
    await expect(client.resolveRedirect('/companies/jump')).rejects.toBeInstanceOf(NotFoundError);
    clearFetch();
  });
});

describe('client-side rate limiter', () => {
  it('consumes tokens without throttling when tokens remain', async () => {
    const spy = stubFetch(() => json({}));
    const client = makeClient({ rateLimit: { perMinute: 600, burst: 100 } });
    await client.request<unknown>({ method: 'GET', path: '/companies' });
    await client.request<unknown>({ method: 'GET', path: '/companies' });
    expect(spy.calls).toHaveLength(2);
    clearFetch();
  });

  it('builder pings when no bucket is configured (no-op path)', async () => {
    stubFetch(() => json({}));
    const client = makeClient();
    await client.request<unknown>({ method: 'GET', path: '/companies' });
    clearFetch();
  });
});
