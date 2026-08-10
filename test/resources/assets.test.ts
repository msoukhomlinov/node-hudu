/**
 * AssetsResource (company-scoped) tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const asset = JSON.parse(readFileSync(join(__dirname, '../__fixtures__/asset.json'), 'utf8'));
const assetsList = JSON.parse(readFileSync(join(__dirname, '../__fixtures__/assets_list.json'), 'utf8'));

function makeClient() { return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }); }

describe('AssetsResource', () => {
  afterEach(() => clearFetch());

  it('get is company-scoped and unwraps the envelope', async () => {
    const spy = stubFetch(() => json({ asset }));
    const r = makeClient().assets;
    const res = await r.get(1, 10);
    expect(res).toEqual(asset);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10');
  });

  it('listAll is company-scoped and walks pages', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('page=1')) return json(assetsList);
      return json({ assets: [] });
    });
    const r = makeClient().assets;
    const res = await r.listAll(1, { archived: true });
    expect(res).toEqual(assetsList.assets);
    expect(spy.calls[0].url).toContain('/api/v1/companies/1/assets?');
    expect(spy.calls[0].url).toContain('archived=true');
  });

  it('list streams assets for a company', async () => {
    stubFetch(() => json(assetsList));
    const r = makeClient().assets;
    const out: unknown[] = [];
    for await (const a of r.list(1, {})) out.push(a);
    expect(out).toEqual(assetsList.assets);
  });

  it('listPages yields pages', async () => {
    stubFetch(() => json(assetsList));
    const r = makeClient().assets;
    const pages: unknown[] = [];
    for await (const p of r.listPages(1, {})) pages.push(p);
    expect(pages).toHaveLength(1);
  });

  it('create (raw) posts to the company-scoped path', async () => {
    const spy = stubFetch(() => json(asset, 201));
    const r = makeClient().assets;
    const res = await r.create(1, { name: 'Laptop-001' });
    expect(res).toEqual(asset);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets');
    expect(spy.calls[0].init.method).toBe('POST');
  });

  it('update (raw) returns raw body as-is', async () => {
    const spy = stubFetch(() => json({ asset }));
    const r = makeClient().assets;
    const res = await r.update(1, 10, { name: 'New' });
    expect(res).toEqual({ asset });
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10');
  });

  it('delete/archive/unarchive hit the right company-scoped URLs', async () => {
    const spy = stubFetch(() => empty(204));
    const r = makeClient().assets;
    await r.delete(1, 10);
    await r.archive(1, 10);
    await r.unarchive(1, 10);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10');
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[1].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10/archive');
    expect(spy.calls[2].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10/unarchive');
  });

  it('moveLayout PUTs asset_layout_id', async () => {
    const spy = stubFetch(() => json(asset));
    const r = makeClient().assets;
    const res = await r.moveLayout(1, 10, { asset_layout_id: 99 });
    expect(res).toEqual(asset);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10/move_layout');
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset_layout_id: 99 }));
  });

  it('listAllAcrossCompanies hits the top-level /assets endpoint', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('page=1')) return json({ assets: assetsList.assets });
      return json({ assets: [] });
    });
    const r = makeClient().assets;
    const res = await r.listAllAcrossCompanies({ company_id: 1 });
    expect(res).toEqual(assetsList.assets);
    expect(spy.calls[0].url).toContain('/api/v1/assets?');
    expect(spy.calls[0].url).toContain('company_id=1');
  });
});
