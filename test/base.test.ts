/**
 * BaseResource shared scaffolding coverage.
 */
import { describe, it, expect } from 'vitest';
import { HttpClient } from '../src/http.js';
import { resolveConfig } from '../src/config.js';
import { BaseResource } from '../src/resources/base.js';
import { CompaniesResource } from '../src/resources/companies.js';
import { HuduConfigError } from '../src/errors.js';
import { stubFetch, json, empty, clearFetch } from './helpers.js';

class ProbeResource extends BaseResource<{ id: number }> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'probes', singleKey: 'probe', listKey: 'probes', createType: 'wrapped', paginated: true });
  }
  companyUrlFor(companyId: number, base: string, id?: number | string): string {
    return this.companyUrl(companyId, base, id);
  }
  createViaBase(data: unknown): Promise<{ id: number }> {
    return this.createOne<{ id: number }>(data);
  }
}

// Misconfigured: 'wrapped' create with no singleKey to unwrap (A15).
class WrappedNoKeyResource extends BaseResource<{ id: number }> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'broken', singleKey: undefined, listKey: undefined, createType: 'wrapped', paginated: true });
  }
}

// Declares 'raw', but the LIVE vendor still wraps its POST body: the defensive create unwrap must
// recover the record (this is the live shape of companies.create / articles.create / procedures.create).
class RawProbeResource extends BaseResource<{ id: number }> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'rawprobes', singleKey: 'probe', listKey: 'rawprobes', createType: 'raw', paginated: true });
  }
  create(data: unknown): Promise<{ id: number }> {
    return this.createOne<{ id: number }>(data);
  }
}

// 'raw' with no singleKey to look for: nothing may be unwrapped.
class RawNoKeyResource extends BaseResource<{ id: number }> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'rawempty', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }
  create(data: unknown): Promise<{ id: number }> {
    return this.createOne<{ id: number }>(data);
  }
}

describe('BaseResource helpers', () => {
  afterEach(() => clearFetch());

  it('rejects createType wrapped with no singleKey (A15)', () => {
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://x', apiKey: 'k' }));
    expect(() => new WrappedNoKeyResource(http)).toThrow(HuduConfigError);
    // wrapped + singleKey is still valid
    expect(() => new ProbeResource(http)).not.toThrow();
  });

  describe('create response envelope (live-verified against a wrapping vendor)', () => {
    const make = (Cls: typeof RawProbeResource | typeof RawNoKeyResource) =>
      new Cls(new HttpClient(resolveConfig({ baseUrl: 'https://x', apiKey: 'k' })));

    it("unwraps a one-key envelope even though the resource declares createType 'raw'", async () => {
      // Live: POST /companies answers {"company":{...}} while api-docs.json documents the bare record.
      stubFetch(() => json({ probe: { id: 9 } }));
      await expect(make(RawProbeResource).create({ name: 'x' })).resolves.toEqual({ id: 9 });
    });

    it('passes a spec-conformant bare record through, single field or not', async () => {
      stubFetch(() => json({ id: 9 }));
      await expect(make(RawProbeResource).create({ name: 'x' })).resolves.toEqual({ id: 9 });
    });

    it('does not unwrap a record that merely CONTAINS the singleKey among other fields', async () => {
      // The collision case: { probe: 1, id: 9 } is a record, not an envelope - unwrapping it would
      // return the number 1 typed as the resource.
      stubFetch(() => json({ probe: 1, id: 9 }));
      await expect(make(RawProbeResource).create({ name: 'x' })).resolves.toEqual({ probe: 1, id: 9 });
    });

    it('does not unwrap when the resource declares no singleKey', async () => {
      stubFetch(() => json({ probe: { id: 9 } }));
      await expect(make(RawNoKeyResource).create({ name: 'x' })).resolves.toEqual({ probe: { id: 9 } });
    });

    it('still unwraps unconditionally for a resource that declares createType wrapped', async () => {
      stubFetch(() => json({ probe: { id: 4 } }));
      const r = new ProbeResource(new HttpClient(resolveConfig({ baseUrl: 'https://x', apiKey: 'k' })));
      await expect(r.createViaBase({ name: 'x' })).resolves.toEqual({ id: 4 });
    });
  });

  it('companyUrl builds nested paths', () => {
    const r = new ProbeResource(new HttpClient(resolveConfig({ baseUrl: 'https://x', apiKey: 'k' })));
    expect(r.companyUrlFor(1, '/assets')).toBe('/companies/1/assets');
    expect(r.companyUrlFor(1, '/assets', 7)).toBe('/companies/1/assets/7');
  });

  it('request/getOne/createOne/updateOne/deleteOne/setArchived work through base', async () => {
    const spy = stubFetch(() => json({ probe: { id: 1 } }));
    const r = new ProbeResource(new HttpClient(resolveConfig({ baseUrl: 'https://x', apiKey: 'k' })));
    // getOne
    const got = await (r as unknown as { getOne(id: number): Promise<{ id: number }> }).getOne(1);
    expect(got).toEqual({ id: 1 });
    expect(spy.calls[0].url).toBe('https://x/api/v1/probes/1');
    // createOne wrapped
    const created = await (r as unknown as { createOne(data: unknown): Promise<{ id: number }> }).createOne({ id: 1 });
    expect(created).toEqual({ id: 1 });
    // updateOne wrapped
    const updated = await (r as unknown as { updateOne(id: number, data: unknown): Promise<{ id: number }> }).updateOne(1, {});
    expect(updated).toEqual({ id: 1 });
  });

  it('deleteOne and setArchived issue the right requests', async () => {
    const spy = stubFetch(() => empty(204));
    const r = new ProbeResource(new HttpClient(resolveConfig({ baseUrl: 'https://x', apiKey: 'k' })));
    await (r as unknown as { deleteOne(id: number): Promise<void> }).deleteOne(1);
    await (r as unknown as { setArchived(id: number, a: boolean): Promise<void> }).setArchived(1, true);
    await (r as unknown as { setArchived(id: number, a: boolean): Promise<void> }).setArchived(1, false);
    expect(spy.calls[0].url).toBe('https://x/api/v1/probes/1');
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[1].url).toBe('https://x/api/v1/probes/1/archive');
    expect(spy.calls[2].url).toBe('https://x/api/v1/probes/1/unarchive');
  });
});

describe('no-progress guard through the SDK base path (codex [6])', () => {
  afterEach(() => clearFetch());

  it('listAll throws no-progress when the server ignores `page` and repeats content', async () => {
    // CompaniesResource is paginated; the mock server returns the SAME 25-item
    // page no matter which `page` it was asked for. The SDK opts into
    // guardNoProgress, so the content-fingerprint guard must throw instead of
    // looping ~100k times.
    const companies = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    stubFetch(() => json({ companies }));
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://x', apiKey: 'k' }));
    const res = new CompaniesResource(http);
    await expect(res.listAll({})).rejects.toBeInstanceOf(HuduConfigError);
  });

  it('listAll yields content when the server responds with advancing page content', async () => {
    // Sanity: a server that genuinely advances pages must not trigger the guard.
    const page1 = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const page2 = Array.from({ length: 25 }, (_, i) => ({ id: i + 26 }));
    const page3 = [{ id: 51 }]; // short terminal page
    stubFetch((url) => {
      if (url.includes('page=1')) return json({ companies: page1 });
      if (url.includes('page=2')) return json({ companies: page2 });
      return json({ companies: page3 });
    });
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://x', apiKey: 'k' }));
    const res = new CompaniesResource(http);
    const all = await res.listAll({});
    expect(all).toHaveLength(51);
    expect(all[0].id).toBe(1);
    expect(all[25].id).toBe(26);
    expect(all[50].id).toBe(51);
  });
});
