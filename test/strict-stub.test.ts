/**
 * Tests for the strictness of test/helpers.ts itself.
 *
 * A stubbed fetch that answers `{}` for any URL cannot notice a wrong URL. These tests pin the two
 * mechanisms that close that hole: shape validation (always on) and declared expectations
 * (opt-in via expectRequests).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../src/client.js';
import { stubFetch, stubFetchAny, expectRequests, json, clearFetch } from './helpers.js';

function makeClient() {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
}

describe('stubbed-request shape validation', () => {
  afterEach(() => clearFetch());

  it('records a violation for a fabricated bad URL, naming the URL and the reason', async () => {
    const spy = stubFetch(() => json({}));
    await fetch('https://hudu.example.com/api/v1/companies/undefined/assets');
    const [violation] = spy.drainViolations();
    expect(spy.calls).toHaveLength(1);
    expect(spy.violations).toHaveLength(0);
    expect(violation.kind).toBe('shape');
    expect(violation.url).toBe('https://hudu.example.com/api/v1/companies/undefined/assets');
    expect(violation.method).toBe('');
    expect(violation.reasons.join(' ')).toContain('path segment "undefined"');
    expect(violation.testName).toContain('records a violation for a fabricated bad URL');
  });

  it.each([
    ['a relative URL', '/api/v1/companies', 'not absolute'],
    ['a foreign origin', 'https://other.example.com/api/v1/companies', 'does not start with the configured base URL'],
    ['a NaN path segment', 'https://hudu.example.com/api/v1/companies/NaN', 'path segment "NaN"'],
    ['a null path segment', 'https://hudu.example.com/api/v1/companies/null', 'path segment "null"'],
    ['an empty path segment', 'https://hudu.example.com/api/v1//companies', 'empty segment'],
    ['a NaN query value', 'https://hudu.example.com/api/v1/companies?page=NaN', '"page=NaN"'],
    ['an undefined query key', 'https://hudu.example.com/api/v1/companies?undefined=1', 'name "undefined"'],
    ['a non-http scheme', 'ftp://hudu.example.com/api/v1/companies', 'unsupported scheme'],
  ])('flags %s', async (_label, url, reason) => {
    const spy = stubFetch(() => json({}), { baseUrl: 'https://hudu.example.com' });
    await fetch(url, { method: 'GET' });
    const [violation] = spy.drainViolations();
    expect(violation.reasons.join(' ')).toContain(reason);
  });

  it('flags a request sent without a method', async () => {
    const spy = stubFetch(() => json({}));
    await fetch('https://hudu.example.com/api/v1/companies');
    expect(spy.drainViolations()[0].reasons.join(' ')).toContain('no HTTP method');
  });

  it('flags a second origin inside one test even without a configured baseUrl', async () => {
    const spy = stubFetch(() => json({}));
    await fetch('https://hudu.example.com/api/v1/companies', { method: 'GET' });
    await fetch('https://elsewhere.example.com/api/v1/companies', { method: 'GET' });
    const violations = spy.drainViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0].url).toContain('elsewhere.example.com');
  });

  it('accepts an ordinary absolute request', async () => {
    const spy = stubFetch(() => json({}));
    await fetch('https://hudu.example.com/api/v1/companies/1', { method: 'GET' });
    expect(spy.violations).toEqual([]);
  });

  it('fails the test at clearFetch() when a violation is not inspected', async () => {
    const spy = stubFetch(() => json({}));
    await fetch('https://hudu.example.com/api/v1/companies/undefined', { method: 'GET' });
    expect(spy.calls).toHaveLength(1);
    expect(() => clearFetch()).toThrow(/Malformed or undeclared stubbed request.*companies\/undefined/s);
  });
});

describe('undeclared requests fail a test with declared expectations', () => {
  afterEach(() => clearFetch());

  it('a request for a wrong URL is undeclared', async () => {
    const spy = stubFetchAny({ baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, [{ method: 'GET', url: 'https://hudu.example.com/api/v1/companies/1' }]);
    const r = makeClient().companies;
    await (r.get as unknown as (id: number) => Promise<unknown>)(2);
    const [violation] = spy.drainViolations();
    expect(violation.kind).toBe('unexpected');
    expect(violation.url).toBe('https://hudu.example.com/api/v1/companies/2');
    expect(violation.reasons[0]).toBe('request was not declared by expectRequests()');
    // the ONE declared call was never made, which is reported too
    expect(() => clearFetch()).toThrow(
      /GET https:\/\/hudu\.example\.com\/api\/v1\/companies\/1 \(1x\).*declared request was never made/s,
    );
  });

  it('a declared URL with an unexpected method is undeclared', async () => {
    const spy = stubFetchAny({ baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, [{ method: 'POST', url: 'https://hudu.example.com/api/v1/companies/1' }]);
    await fetch('https://hudu.example.com/api/v1/companies/1', { method: 'GET' });
    expect(spy.drainViolations()[0].method).toBe('GET');
    spy.drainViolations();
    expect(() => clearFetch()).toThrow(/Malformed or undeclared/);
  });

  it('a declared call made twice is an extra call', async () => {
    const spy = stubFetch(() => json({ company: { id: 1 } }), { baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, [{ method: 'GET', url: 'https://hudu.example.com/api/v1/companies/1' }]);
    const r = makeClient().companies;
    await r.get(1);
    await r.get(1);
    const [violation] = spy.drainViolations();
    expect(violation.kind).toBe('unexpected');
    expect(violation.reasons.join(' ')).toContain('declared requests still open: <none>');
  });

  it('times: "any" tolerates repeats but still rejects a different URL', async () => {
    const spy = stubFetch(() => json({ company: { id: 1 } }), { baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, [{ method: 'GET', url: /\/api\/v1\/companies\/1(\?.*)?$/, times: 'any' }]);
    const r = makeClient().companies;
    await r.get(1);
    await r.get(1);
    expect(spy.violations).toEqual([]);
  });

  it('a declared request that is never made fails the test', async () => {
    const spy = stubFetch(() => json({}));
    expectRequests(spy, [{ method: 'DELETE', url: 'https://hudu.example.com/api/v1/companies/1' }]);
    expect(() => clearFetch()).toThrow(/GET|DELETE.*never made/s);
  });
});

describe('adoption: a wrong URL that used to ship green now fails', () => {
  afterEach(() => clearFetch());

  it('companies.get() with a missing id now fails instead of passing on a {}-for-any-URL stub', async () => {
    const spy = stubFetchAny({ baseUrl: 'https://hudu.example.com' });
    const r = makeClient().companies;
    const res = await (r.get as unknown as (id: unknown) => Promise<unknown>)(undefined);
    // The loose stub still answers, so the call itself resolves - the failure is the URL shape.
    expect(res).toEqual({});
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/undefined');
    expect(() => clearFetch()).toThrow(/companies\/undefined/);
  });

  it('the same call with a real id declares its URL and passes', async () => {
    const spy = stubFetch(() => json({ company: { id: 1, name: 'Acme' } }), { baseUrl: 'https://hudu.example.com' });
    expectRequests(spy, [{ method: 'GET', url: 'https://hudu.example.com/api/v1/companies/1' }]);
    const r = makeClient().companies;
    await expect(r.get(1)).resolves.toMatchObject({ id: 1 });
    expect(spy.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET https://hudu.example.com/api/v1/companies/1',
    ]);
    expect(spy.violations).toEqual([]);
  });
});
