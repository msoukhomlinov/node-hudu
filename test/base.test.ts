/**
 * BaseResource shared scaffolding coverage.
 */
import { describe, it, expect } from 'vitest';
import { HttpClient } from '../src/http.js';
import { resolveConfig } from '../src/config.js';
import { BaseResource } from '../src/resources/base.js';
import { stubFetch, json, empty, clearFetch } from './helpers.js';

class ProbeResource extends BaseResource<{ id: number }> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'probes', singleKey: 'probe', listKey: 'probes', createType: 'wrapped', paginated: true });
  }
  companyUrlFor(companyId: number, base: string, id?: number | string): string {
    return this.companyUrl(companyId, base, id);
  }
}

describe('BaseResource helpers', () => {
  afterEach(() => clearFetch());

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
