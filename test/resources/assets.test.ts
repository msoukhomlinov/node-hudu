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
    // A-1: request body is wrapped in { asset } (live n8n node / PUT example), response is the flat Asset.
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset: { name: 'Laptop-001' } }));
  });

  it('update (raw) returns raw body as-is', async () => {
    const spy = stubFetch(() => json({ asset }));
    const r = makeClient().assets;
    const res = await r.update(1, 10, { name: 'New' });
    expect(res).toEqual({ asset });
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10');
    expect(spy.calls[0].init.method).toBe('PUT');
    // A-1: request body is wrapped in { asset }; response stays flat (pass-through).
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset: { name: 'New' } }));
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

  it('listAcrossCompanies streams and listAcrossCompaniesPages yields pages (B18)', async () => {
    const spy = stubFetch((url) => (url.includes('page=1') ? json({ assets: assetsList.assets }) : json({ assets: [] })));
    const r = makeClient().assets;
    const items: unknown[] = [];
    for await (const a of r.listAcrossCompanies({ company_id: 1 })) items.push(a);
    expect(items).toEqual(assetsList.assets);
    expect(spy.calls[0].url).toContain('/api/v1/assets?');
    expect(spy.calls[0].url).toContain('company_id=1');
    expect(spy.calls[0].url).toContain('page_size=');
    const pages: unknown[] = [];
    for await (const pg of r.listAcrossCompaniesPages({})) pages.push(pg);
    expect(pages).toHaveLength(1);
    expect((pages[0] as { items: unknown[] }).items).toEqual(assetsList.assets);
  });

  it('update wraps the body in { asset } while moveLayout keeps its own shape (A-1/C1)', async () => {
    const spy = stubFetch(() => json({ asset }));
    const r = makeClient().assets;
    const updated = await r.update(1, 10, { name: 'New' });
    expect(updated).toEqual({ asset });
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10');
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset: { name: 'New' } }));
    const spy2 = stubFetch(() => json({ wrapped: true, asset }));
    const moved = await r.moveLayout(1, 10, { asset_layout_id: 5 });
    expect(moved).toEqual({ wrapped: true, asset });
    expect(spy2.calls[0].url).toContain('/move_layout');
    expect(spy2.calls[0].init.body).toBe(JSON.stringify({ asset_layout_id: 5 }));
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

  it('listAcrossCompanies honours caller page/page_size (QR-2)', async () => {
    const spy = stubFetch(() => json({ assets: assetsList.assets }));
    const r = makeClient().assets;
    const items: unknown[] = [];
    for await (const a of r.listAcrossCompanies({ page: 3, page_size: 100 })) items.push(a);
    expect(items).toEqual(assetsList.assets);
    expect(spy.calls[0].url).toContain('page=3');
    expect(spy.calls[0].url).toContain('page_size=100');
    // assetsList.assets is shorter than page_size 100, so exactly one page is fetched.
    expect(spy.calls).toHaveLength(1);
  });


  it('listAcrossCompanies throws no-progress when /assets ignores page (QR-3/codex[15])', async () => {
    // Server ignores `page` and returns the same FULL page (25 items => hasMore true).
    const full = { assets: Array.from({ length: 25 }, (_, i) => ({ ...asset, id: i + 1 })) };
    const spy = stubFetch(() => json(full));
    const r = makeClient().assets;
    const items: unknown[] = [];
    await expect(async () => {
      for await (const a of r.listAcrossCompanies()) items.push(a);
    }).rejects.toThrow(/no progress|same full page content/);
    // It must not loop forever / exceed 100k requests.
    expect(spy.calls.length).toBeLessThan(10);
  });


  it('listAcrossCompaniesPages honours caller page/page_size (QR-2)', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('page=3')) return json({ assets: assetsList.assets });
      return json({ assets: [] });
    });
    const r = makeClient().assets;
    const pages: unknown[] = [];
    for await (const pg of r.listAcrossCompaniesPages({ page: 3, page_size: 100 })) pages.push(pg);
    expect(pages).toHaveLength(1);
    expect(spy.calls[0].url).toContain('page=3');
    expect(spy.calls[0].url).toContain('page_size=100');
  });

  it('listAllAcrossCompanies uses caller page_size across all pages (QR-2)', async () => {
    // Each page carries a distinct id range so the no-progress guard (content
    // signature) sees advancing data.
    const spy = stubFetch((url) => {
      const pageNum = Number(url.match(/page=(\d+)/)?.[1] ?? '1');
      if (pageNum === 1 || pageNum === 2) {
        const start = (pageNum - 1) * 100;
        return json({ assets: Array.from({ length: 100 }, (_, i) => ({ ...asset, id: start + i + 1 })) });
      }
      return json({ assets: [] });
    });
    const r = makeClient().assets;
    const res = await r.listAllAcrossCompanies({ page_size: 100 });
    expect(res).toHaveLength(200);
    expect(spy.calls[0].url).toContain('page_size=100');
    expect(spy.calls[1].url).toContain('page_size=100');
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[1].url).toContain('page=2');
  });
});
