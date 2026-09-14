/**
 * HTTP transport tests (HttpClient.request) using a mocked global fetch.
 */
import { describe, it, expect } from 'vitest';
import { HttpClient, unwrapByKey, unwrapList } from '../src/http.js';
import { HuduClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { HuduNetworkError, RateLimitError, BadRequestError, NotFoundError, HuduError } from '../src/errors.js';
import { clearFetch, stubFetch, json, text, empty, expectRequests, type FetchSpy } from './helpers.js';

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
    const spy = stubFetch(() => json({}), { baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, [{ method: 'GET', url: 'https://hudu.example.com/api/v1/companies' }]);
    const client = makeClient();
    await client.request<unknown>({ method: 'GET', path: '/companies' });
    const headers = spy.calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key');
    expect(headers['Accept']).toBe('application/json');
    clearFetch();
  });

  it('sends a JSON body with content-type', async () => {
    const spy = stubFetch(() => json({ company: { id: 1 } }), { baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, [{ method: 'POST', url: 'https://hudu.example.com/api/v1/companies' }]);
    const client = makeClient();
    const res = await client.request<unknown>({ method: 'POST', path: '/companies', body: { name: 'Acme' } });
    const headers = spy.calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ name: 'Acme' }));
    expect(res).toEqual({ company: { id: 1 } });
    clearFetch();
  });

  it('does not set content-type when there is no body', async () => {
    const spy = stubFetch(() => json({}), { baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, [{ method: 'DELETE', url: 'https://hudu.example.com/api/v1/companies/1' }]);
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

  it('does not fabricate retryAfter when the Retry-After header is absent (A13)', async () => {
    // Number('') === 0 and Number.isFinite(0) === true, so the old code assigned
    // retryAfter: 0 when the header was missing — indistinguishable from
    // "retry immediately". Parse+assign only when the header is present.
    const spy = stubFetch(() => json({ detail: 'rate' }, 429));
    const client = makeClient({ maxRetries: 0 });
    await expect(client.request<unknown>({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      name: 'RateLimitError',
      status: 429,
      retryAfter: undefined,
    });
    expect(spy.calls).toHaveLength(1);
    clearFetch();
  });

  it('falls back to exponential backoff when Retry-After is absent (A13)', async () => {
    let n = 0;
    const spy = stubFetch(() => { n++; return n === 1 ? json({}, 429) : json({ ok: true }); });
    const client = makeClient({ maxRetries: 3 });
    const res = await client.request<unknown>({ method: 'GET', path: '/x' });
    expect(res).toEqual({ ok: true });
    expect(n).toBe(2);
    expect(spy.calls).toHaveLength(2);
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

  it('cancels the response body before retrying so the socket can be reused (B6)', async () => {
    let cancelCount = 0;
    let n = 0;
    stubFetch(() => {
      if (n++ === 0) return new Response(new ReadableStream({ cancel() { cancelCount++; } }), { status: 500 });
      return json({ ok: true });
    });
    const client = makeClient({ maxRetries: 2 });
    const res = await client.request<unknown>({ method: 'GET', path: '/x' });
    expect(res).toEqual({ ok: true });
    expect(cancelCount).toBe(1);
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

  it('timeoutMs bounds the whole call, not just one attempt (B8)', async () => {
    // A perpetually-failing 500 with a tiny whole-call budget must surface a
    // timeout instead of retrying forever past timeoutMs (B6/B8).
    let n = 0;
    stubFetch(() => { n++; return json({}, 500); });
    const client = makeClient({ maxRetries: 5, timeoutMs: 30 });
    await expect(client.request<unknown>({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      name: 'HuduNetworkError',
      code: 'NETWORK_ERROR',
    });
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
  it('unwrapByKey passes a non-record through unchanged rather than fabricating {} (B3)', () => {
    const arr = [1, 2];
    expect(unwrapByKey(arr, 'x')).toEqual(arr);
  });
  it('unwrapByKey surfaces undefined (e.g. a 204/empty body) instead of fabricating {} (B3)', () => {
    expect(unwrapByKey(undefined, 'x')).toBeUndefined();
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
  it('unwrapList treats an empty record (bare {}) as an empty list, not a throw (close-check F3)', () => {
    expect(unwrapList<number>({}, 'ids')).toEqual([]);
  });
  it('unwrapList passes a bare array through unchanged', () => {
    expect(unwrapList<number>([5, 6], undefined)).toEqual([5, 6]);
    expect(unwrapList<number>([5, 6], 'items')).toEqual([5, 6]);
  });
  it('unwrapList extracts the keyed array when present', () => {
    expect(unwrapList<number>({ meta: 'x', items: [5, 6] }, 'items')).toEqual([5, 6]);
  });
  it('unwrapList throws when a listed envelope key is missing/mismatched (B4)', () => {
    // A non-list record whose key is absent, and a scalar, are genuine shape
    // errors and still throw (F3).
    expect(() => unwrapList({ a: 1, b: 'c' }, 'nope')).toThrow(HuduError);
    expect(() => unwrapList('scalar', 'nope')).toThrow(HuduError);
    expect(() => unwrapList({ items: 5 }, 'items')).toThrow(HuduError);
  });
  it('unwrapList yields [] for an empty/null body or a null envelope value (F3)', () => {
    expect(unwrapList(undefined, 'nope')).toEqual([]);
    expect(unwrapList(null, 'nope')).toEqual([]);
    expect(unwrapList<number>({ items: null }, 'items')).toEqual([]);
    expect(unwrapList<number>({ items: undefined }, 'items')).toEqual([]);
  });
  it('unwrapList still passes a bare array through when a key is given (B4)', () => {
    expect(unwrapList<number>([1, 2], 'anything')).toEqual([1, 2]);
  });
  it('unwrapList passes a non-array through unchanged when no key is given (ARCHITECTURE)', () => {
    // No key => the body is expected to be the array itself; pass through verbatim.
    const data = { not: 'a list' };
    expect(unwrapList(data, undefined)).toBe(data);
  });
  it('unwrapList keeps a real empty array valid (B4)', () => {
    expect(unwrapList<number>({ items: [] }, 'items')).toEqual([]);
    expect(unwrapList<number>([], 'anything')).toEqual([]);
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

  it('wraps a network failure in a HuduNetworkError (B9)', async () => {
    stubFetch(() => { throw new TypeError('fetch failed'); });
    const client = makeClient();
    await expect(client.resolveRedirect('/companies/jump')).rejects.toBeInstanceOf(HuduNetworkError);
    clearFetch();
  });
  it('throws the mapped error on a non-2xx/3xx response', async () => {
    stubFetch(() => json({}, 404));
    const client = makeClient();
    await expect(client.resolveRedirect('/companies/jump')).rejects.toBeInstanceOf(NotFoundError);
    clearFetch();
  });
});

describe('binary downloads (A14)', () => {
  it('download() returns a real Blob with the raw bytes, not text', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x0a, 0xff, 0xfe]);
    const spy = stubFetch(() => new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    const client = makeClient();
    const blob = await client.download({ method: 'GET', path: '/exports/7', query: { download: true } });
    expect(blob).toBeInstanceOf(Blob);
    const recovered = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(recovered)).toEqual(Array.from(bytes));
    // binary content must not be munged by UTF-8 decoding
    expect(recovered.length).toBe(bytes.length);
    clearFetch();
  });

  it('request with responseType blob returns binary even when it looks like text', async () => {
    const body = 'not really a parseable payload';
    stubFetch(() => new Response(body, { status: 200 }));
    const client = makeClient();
    const blob = await client.request<Blob>({ method: 'GET', path: '/uploads/3', responseType: 'blob' });
    const text = await blob.text();
    expect(text).toBe(body);
    clearFetch();
  });

  it('text stays the default for non-blob requests', async () => {
    stubFetch(() => json({ ok: 1 }));
    const client = makeClient();
    const res = await client.request<unknown>({ method: 'GET', path: '/companies' });
    expect(res).toEqual({ ok: 1 });
    clearFetch();
  });

  it('wraps an AbortError from blob() during a download as HuduNetworkError (download body abort)', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    const resp = new Response('partial-body');
    resp.blob = () => Promise.reject(abortErr);
    stubFetch(() => resp);
    const client = makeClient({ timeoutMs: 1000 });
    await expect(
      client.download({ method: 'GET', path: '/exports/7', query: { download: true } }),
    ).rejects.toMatchObject({
      name: 'HuduNetworkError',
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(/timed out after 1000ms/i),
    });
    clearFetch();
  });

  it('wraps a TimeoutError from blob() during a download as HuduNetworkError, not a raw error', async () => {
    const timeoutErr = new Error('signal timed out');
    timeoutErr.name = 'TimeoutError';
    const resp = new Response('partial-body');
    resp.blob = () => Promise.reject(timeoutErr);
    stubFetch(() => resp);
    const client = makeClient({ timeoutMs: 2500 });
    await expect(
      client.download({ method: 'GET', path: '/uploads/3' }),
    ).rejects.toMatchObject({
      name: 'HuduNetworkError',
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(/timed out after 2500ms/i),
    });
    clearFetch();
  });

  it('wraps an AbortError from text() on the final 2xx body as HuduNetworkError, not a raw error', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    const resp = new Response('x');
    resp.text = () => Promise.reject(abortErr);
    stubFetch(() => resp);
    const client = makeClient({ timeoutMs: 1000 });
    await expect(client.request<unknown>({ method: 'GET', path: '/companies' })).rejects.toMatchObject({
      name: 'HuduNetworkError',
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(/timed out/i),
    });
    clearFetch();
  });

  it('wraps an AbortError from text() on a non-ok body as HuduNetworkError, not a NotFoundError', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    const resp = new Response(null, { status: 404 });
    resp.text = () => Promise.reject(abortErr);
    stubFetch(() => resp);
    const client = makeClient({ timeoutMs: 1000 });
    await expect(client.request<unknown>({ method: 'GET', path: '/companies/999' })).rejects.toMatchObject({
      name: 'HuduNetworkError',
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(/timed out/i),
    });
    clearFetch();
  });

  it('wraps a non-abort body-transfer failure (TypeError) as HuduNetworkError with a network message', async () => {
    // A server/proxy sending headers then dropping the connection mid-body makes
    // Node's blob() reject with a TypeError (e.g. "terminated") — which must
    // surface as a HuduNetworkError, NOT a raw untyped TypeError.
    const otherErr = new TypeError('terminated');
    const resp = new Response('x');
    resp.blob = () => Promise.reject(otherErr);
    stubFetch(() => resp);
    const client = makeClient({ timeoutMs: 1000 });
    await expect(client.download({ method: 'GET', path: '/exports/7' })).rejects.toMatchObject({
      name: 'HuduNetworkError',
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(/network/i),
    });
    clearFetch();
  });

  it('wraps a non-Error rejection from blob() (thrown string) as HuduNetworkError, not leaked raw', async () => {
    const resp = new Response('x');
    resp.blob = () => Promise.reject('boom');
    stubFetch(() => resp);
    const client = makeClient({ timeoutMs: 1000 });
    await expect(client.download({ method: 'GET', path: '/exports/7' })).rejects.toMatchObject({
      name: 'HuduNetworkError',
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(/network/i),
    });
    clearFetch();
  });

  it('wraps a non-abort body-transfer failure from text() on a 2xx body as HuduNetworkError', async () => {
    const otherErr = new Error('terminated');
    const resp = new Response('x');
    resp.text = () => Promise.reject(otherErr);
    stubFetch(() => resp);
    const client = makeClient({ timeoutMs: 1000 });
    await expect(client.request<unknown>({ method: 'GET', path: '/companies' })).rejects.toMatchObject({
      name: 'HuduNetworkError',
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(/network/i),
    });
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

  it('serialises concurrent calls and never lets the token bucket go negative (B11)', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      stubFetch(() => { n++; return json({}); });
      // 1 token/min, burst 1 -> the second concurrent call must wait ~60s, not
      // fire alongside the first; tokens must not drift negative.
      const client = makeClient({ rateLimit: { perMinute: 1, burst: 1 }, timeoutMs: 600_000 });
      const p1 = client.request<unknown>({ method: 'GET', path: '/a' });
      const p2 = client.request<unknown>({ method: 'GET', path: '/b' });
      await vi.advanceTimersByTimeAsync(0); // first call acquires the only token
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(60_001); // refill exactly one token
      await Promise.all([p1, p2]);
      expect(n).toBe(2);
    } finally {
      clearFetch();
      vi.useRealTimers();
    }
  });

  it('bounds the token wait by timeoutMs — request throws near timeoutMs instead of hanging (F1)', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      stubFetch(() => { n++; return json({}); });
      // burst 1, 1 token/min: the second call must wait ~60s to refill, but the
      // whole-call deadline (1s) must bound that wait so it throws near 1s
      // instead of still sleeping toward 60s then reporting a false timeout.
      const client = makeClient({ rateLimit: { perMinute: 1, burst: 1 }, timeoutMs: 1000 });
      const p1 = client.request<unknown>({ method: 'GET', path: '/a' });
      const p2 = client.request<unknown>({ method: 'GET', path: '/b' });
      await vi.advanceTimersByTimeAsync(0); // first call acquires the only token
      expect(n).toBe(1);
      // attach the rejection handler BEFORE advancing, so the timeout that fires
      // during the advance is handled (no unhandled-rejection leak)
      const p2err = p2.then(
        () => null,
        (e) => e as Error,
      );
      await vi.advanceTimersByTimeAsync(1500); // push past the 1000ms deadline
      const err = await p2err;
      expect(err).toBeInstanceOf(HuduNetworkError);
      expect(err?.message).toMatch(/timed out/i);
      await p1; // the first call succeeded within budget
      expect(n).toBe(1); // no late fetch happened for the timed-out call
    } finally {
      clearFetch();
      vi.useRealTimers();
    }
  });

  it('bounds the QUEUE-wait by its own deadline — a retried request queued behind a later refill-waiting request rejects at ITS deadline, not the head release (F2)', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic backoff jitter
      let n = 0;
      // A's single attempt fails 429 with a 500ms Retry-After; everything after is 200.
      stubFetch(() => {
        n++;
        if (n === 1) return json({}, 429, { 'Retry-After': '0.5' });
        return json({ ok: true });
      });
      // 1 token/min, burst 1: only one token exists, refill is ~60s.
      const client = makeClient({ rateLimit: { perMinute: 1, burst: 1 }, timeoutMs: 1000, maxRetries: 5 });
      const pA = client.request<unknown>({ method: 'GET', path: '/a' });
      await vi.advanceTimersByTimeAsync(0); // A consumes the only token, gets 429, enters 500ms backoff
      await vi.advanceTimersByTimeAsync(490); // t=490: A's backoff still pending
      // B starts later (t=490): consumeOne finds the bucket empty (A holds the token) and
      // sleeps for the ~1s refill, capped by B's own later deadline (t=1490). B holds the queue.
      const pB = client.request<unknown>({ method: 'GET', path: '/b' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10); // t=500: A's backoff ends, A retries -> queued BEHIND B.
      // A's whole-call deadline is t=1000 (it started at t=0) — far earlier than B's t=1490 release.
      // Guard against unhandled rejections before advancing past A's deadline.
      const aErr = pA.then(
        () => null,
        (e) => e as Error,
      );
      const bRes = pB.then(() => null, (e) => e as Error);
      await vi.advanceTimersByTimeAsync(500); // t=1000: A's own queue-wait deadline fires
      const err = await aErr;
      expect(err).toBeInstanceOf(HuduNetworkError);
      expect(err?.message).toMatch(/timed out/i);
      expect(n).toBe(1); // A rejected while still queued — it never re-fetched
      // The queue is not corrupted by A's timeout: B still holds the head and is
      // released at its own (later) deadline, surfacing its own rate-limit timeout.
      await vi.advanceTimersByTimeAsync(60_000);
      const berr = await bRes;
      expect(berr).toBeInstanceOf(HuduNetworkError);
      expect(berr?.message).toMatch(/timed out/i);
      expect(n).toBe(1); // neither request ever issued a late fetch
    } finally {
      vi.restoreAllMocks();
      clearFetch();
      vi.useRealTimers();
    }
  });
});

describe('Retry-After: delta-seconds and HTTP-date (RFC 7231)', () => {
  it('keeps the existing delta-seconds behaviour (integer and fractional)', async () => {
    stubFetch(() => json({ detail: 'rate' }, 429, { 'Retry-After': '12' }));
    const client = makeClient({ maxRetries: 0 });
    await expect(client.request<unknown>({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      retryAfter: 12,
    });
    clearFetch();

    stubFetch(() => json({ detail: 'rate' }, 429, { 'Retry-After': '0.5' }));
    const client2 = makeClient({ maxRetries: 0 });
    await expect(client2.request<unknown>({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      retryAfter: 0.5,
    });
    clearFetch();
  });

  it('converts an HTTP-date Retry-After into a delta from now', async () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    stubFetch(() => json({ detail: 'rate' }, 429, { 'Retry-After': when }));
    const client = makeClient({ maxRetries: 0 });
    const err = await client.request<unknown>({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    // 30s minus the (tiny) test execution time, and definitely not NaN/undefined.
    expect((err as { retryAfter?: number }).retryAfter).toBeGreaterThan(25);
    expect((err as { retryAfter?: number }).retryAfter).toBeLessThanOrEqual(30);
    clearFetch();
  });

  it('clamps an HTTP-date Retry-After in the past to 0 (retry now, not never)', async () => {
    const when = new Date(Date.now() - 60_000).toUTCString();
    stubFetch(() => json({ detail: 'rate' }, 429, { 'Retry-After': when }));
    const client = makeClient({ maxRetries: 0 });
    await expect(client.request<unknown>({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      retryAfter: 0,
    });
    clearFetch();
  });

  it('treats an unparseable Retry-After as absent so the backoff path is unchanged', async () => {
    const spy = stubFetch(() => json({ detail: 'rate' }, 429, { 'Retry-After': 'very soon, please' }));
    const client = makeClient({ maxRetries: 0 });
    await expect(client.request<unknown>({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      retryAfter: undefined,
    });
    expect(spy.calls).toHaveLength(1);
    clearFetch();
  });

  it('waits out an HTTP-date Retry-After instead of the shorter exponential backoff', async () => {
    // Regression guard for the timing bug: an HTTP-date used to parse to NaN, be
    // read as "no hint", and fall back to 200ms for attempt 0 — retrying BEFORE
    // the server said it was ready. The date is rounded UP to a whole second
    // because an HTTP-date carries no sub-second precision, so the honoured delay
    // is between 700ms and 1700ms and must dominate the 200ms backoff.
    let n = 0;
    stubFetch(() => {
      n += 1;
      if (n === 1) {
        const target = Math.ceil((Date.now() + 700) / 1000) * 1000;
        return json({}, 429, { 'Retry-After': new Date(target).toUTCString() });
      }
      return json({ ok: true });
    });
    const client = makeClient({ maxRetries: 2 });
    const started = Date.now();
    const res = await client.request<unknown>({ method: 'GET', path: '/x' });
    const elapsed = Date.now() - started;
    expect(res).toEqual({ ok: true });
    expect(n).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(650);
    clearFetch();
  });
});

describe('getRateLimitStatus', () => {
  function statusOf(client: HttpClient) {
    return client.getRateLimitStatus();
  }

  it('reports a plain, synchronous, non-throttled snapshot for a fresh client with no limiter', () => {
    const client = makeClient();
    const status = statusOf(client);
    expect(status).toEqual({
      enabled: false,
      throttled: false,
      availableTokens: 0,
      burst: 0,
      queued: 0,
      inFlight: 0,
    });
    expect(status.lastRetryAfterSeconds).toBeUndefined();
    // Synchronous: the state is local, so no promise is returned.
    expect((status as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('reports the configured bucket for a fresh client with a limiter', () => {
    const client = makeClient({ rateLimit: { perMinute: 60, burst: 3 } });
    const status = statusOf(client);
    expect(status.enabled).toBe(true);
    expect(status.throttled).toBe(false);
    expect(status.burst).toBe(3);
    expect(status.availableTokens).toBeGreaterThan(2.9);
    expect(status.availableTokens).toBeLessThanOrEqual(3);
    expect(status.queued).toBe(0);
    expect(status.inFlight).toBe(0);
  });

  it('drops the available token after a call and reports the honoured Retry-After hint', async () => {
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? json({}, 429, { 'Retry-After': '0.01' }) : json({ ok: true });
    });
    const client = makeClient({ rateLimit: { perMinute: 60, burst: 2 }, maxRetries: 2 });
    const before = statusOf(client);
    await client.request<unknown>({ method: 'GET', path: '/x' });
    const after = statusOf(client);
    expect(after.enabled).toBe(true);
    // One token (of the two) was spent; the bucket refills at 60/min, so it has
    // not climbed back to the burst within the test.
    expect(after.availableTokens).toBeLessThan(before.availableTokens);
    // Two acquisitions (the 429 and the retry) drained the burst of 2; the 60/min
    // refill cannot restore a whole token inside the test.
    expect(after.availableTokens).toBeLessThan(0.5);
    expect(after.throttled).toBe(true);
    expect(after.inFlight).toBe(0);
    expect(after.lastRetryAfterSeconds).toBe(0.01);
    clearFetch();
  });

  it('counts an in-flight request while it is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubFetch(async () => { await gate; return json({ ok: true }); });
    const client = makeClient();
    const pending = client.request<unknown>({ method: 'GET', path: '/x' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusOf(client).inFlight).toBe(1);
    release();
    await pending;
    expect(statusOf(client).inFlight).toBe(0);
    clearFetch();
  });

  it('never mutates the limiter: repeated reads do not consume tokens', () => {
    const client = makeClient({ rateLimit: { perMinute: 60, burst: 5 } });
    const first = statusOf(client);
    const second = statusOf(client);
    const third = statusOf(client);
    // Reads may only track elapsed refill; they must never spend a token.
    expect(second.availableTokens).toBeGreaterThanOrEqual(first.availableTokens);
    expect(third.availableTokens).toBeGreaterThanOrEqual(second.availableTokens);
    expect(third.availableTokens).toBeGreaterThan(4.9);
  });

  it('is exposed additively on HuduClient and delegates to the transport state', () => {
    const plain = new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
    expect(plain.getRateLimitStatus()).toMatchObject({ enabled: false, inFlight: 0, queued: 0 });
    const limited = new HuduClient({
      baseUrl: 'https://hudu.example.com',
      apiKey: 'k',
      rateLimit: { perMinute: 60, burst: 4 },
    });
    expect(limited.getRateLimitStatus()).toMatchObject({ enabled: true, burst: 4, throttled: false });
  });
});

describe('SEC-2 — an error surface never echoes the query string', () => {
  it('reports the path only for a vendor error and for a network failure', async () => {
    const spy = stubFetch(() => json({ error: { message: 'boom' } }, 500));
    const client = makeClient();
    let caught: HuduError | undefined;
    try {
      await client.request<unknown>({
        method: 'GET',
        path: '/articles',
        query: { search: 'top-secret-search-term', page: 1 },
      });
    } catch (err) {
      caught = err as HuduError;
    }
    expect(caught?.code).toBe('SERVER_ERROR');
    // `err.url` and the message are the values that reach a log, a transcript or a bug report:
    // the caller's search terms must not travel with them.
    expect(caught?.url).toBe('https://hudu.example.com/api/v1/articles');
    expect(caught?.message).not.toContain('top-secret-search-term');
    expect(spy.calls[0].url).toContain('top-secret-search-term'); // the REQUEST still carries it
    clearFetch();
  });

  it('strips the query from the URL a rate-limit refusal reports', async () => {
    stubFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '1' } }));
    const client = makeClient({ maxRetries: 0 });
    let caught: HuduError | undefined;
    try {
      await client.request<unknown>({ method: 'GET', path: '/articles', query: { search: 'secret-term' } });
    } catch (err) {
      caught = err as HuduError;
    }
    expect(caught?.code).toBe('RATE_LIMIT');
    expect(caught?.url).toBe('https://hudu.example.com/api/v1/articles');
    clearFetch();
  });
});
