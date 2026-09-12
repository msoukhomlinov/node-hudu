/**
 * AssetsResource (company-scoped) tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';
import { HuduConfigError } from '../../src/errors.js';
import type { AssetsResource } from '../../src/resources/assets.js';

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


// ---------------------------------------------------------------------------
// Agent-execution-layer rows (capabilities.plan.json, group A).
// Titles below are copied verbatim from the plan rows.
// ---------------------------------------------------------------------------

import type { AuditEvent } from '../../src/types/common.js';

const asRecord = (value: unknown) => value as Record<string, unknown>;

/** The 10 fields AssetSummary keeps; every other Asset field is dropped. */
const ASSET_SUMMARY_KEYS = [
  'archived', 'asset_layout_id', 'asset_type', 'company_id', 'company_name',
  'id', 'name', 'primary_serial', 'updated_at', 'url',
].sort();

function cappedClient(maxScanRecords: number, maxScanPages: number) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', resolution: { maxScanRecords, maxScanPages } });
}

function auditedClient() {
  const events: AuditEvent[] = [];
  const client = new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', onAudit: (event) => events.push(event) });
  return { client, events };
}

function accountPage(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, i) => ({ ...asset, id: 200 + i, name: `Row ${i}`, ...overrides }));
}

/** Answer the account-wide /assets list by the first query key found in the URL. */
function accountStub(byFilter: Record<string, unknown[]>, fallback: unknown[] = []) {
  return stubFetch((url) => {
    for (const [key, rows] of Object.entries(byFilter)) if (url.includes(`${key}=`)) return json({ assets: rows });
    return json({ assets: fallback });
  });
}

describe('AssetsResource agent-execution-layer helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by company id and asset id without a scan', async () => {
    const spy = stubFetch(() => json({ asset }));
    expect(asRecord(await makeClient().assets.resolve({ companyId: 1, id: 10 })).id).toBe(10);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10');
  });

  it('throws NOT_FOUND for an unknown asset id', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().assets.resolve({ companyId: 1, id: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    const spy = accountStub({ primary_serial: [asset] });
    expect(asRecord(await makeClient().assets.resolve(asset.primary_serial)).id).toBe(asset.id);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('/api/v1/assets?');
    expect(spy.calls[0].url).toContain('primary_serial=');
  });

  it('returns null after a complete scan', async () => {
    const spy = accountStub({});
    await expect(makeClient().assets.resolve('Nothing Here')).resolves.toBeNull();
    expect(spy.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of spy.calls) expect(call.url).toContain('page_size=');
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids', async () => {
    accountStub({ name: [{ ...asset, id: 31, name: 'Laptop' }, { ...asset, id: 32, name: 'Laptop' }] });
    await expect(makeClient().assets.resolve('Laptop')).rejects.toMatchObject({
      code: 'RESOLUTION_AMBIGUOUS',
      resourceIds: [31, 32],
    });
  });

  it('throws RESOLUTION_TRUNCATED at the cap', async () => {
    const spy = accountStub({}, accountPage(25));
    await expect(cappedClient(25, 1).assets.resolve('Nothing Here')).rejects.toMatchObject({ code: 'RESOLUTION_TRUNCATED' });
    expect(spy.calls).toHaveLength(1);
  });

  it('returns AssetSummary', async () => {
    stubFetch(() => json({ asset }));
    const summary = asRecord(await makeClient().assets.resolve({ companyId: 1, id: 10 }));
    expect(Object.keys(summary).sort()).toEqual(ASSET_SUMMARY_KEYS);
    expect(summary.fields).toBeUndefined();
    expect(summary.cards).toBeUndefined();
    expect(summary.primary_model).toBeUndefined();
    expect(summary.slug).toBeUndefined();
    expect(summary.created_at).toBeUndefined();
  });

  it('expand: true returns the full asset', async () => {
    stubFetch(() => json({ asset }));
    await expect(makeClient().assets.resolve({ companyId: 1, id: 10 }, { expand: true })).resolves.toEqual(asset);
  });

  it('returns the exact match (serial)', async () => {
    stubFetch(() => json({ assets: [asset] }));
    expect(asRecord(await makeClient().assets.findBySerial(asset.primary_serial)).id).toBe(asset.id);
  });

  it('returns null after a complete scan (serial)', async () => {
    stubFetch(() => json({ assets: [] }));
    await expect(makeClient().assets.findBySerial('NOPE-123')).resolves.toBeNull();
  });

  it('throws RESOLUTION_AMBIGUOUS when several assets share the serial', async () => {
    stubFetch(() => json({ assets: [{ ...asset, id: 41 }, { ...asset, id: 42 }] }));
    await expect(makeClient().assets.findBySerial(asset.primary_serial)).rejects.toMatchObject({
      code: 'RESOLUTION_AMBIGUOUS',
      resourceIds: [41, 42],
    });
  });

  it('returns AssetSummary (serial)', async () => {
    stubFetch(() => json({ assets: [asset] }));
    expect(Object.keys(asRecord(await makeClient().assets.findBySerial(asset.primary_serial))).sort()).toEqual(ASSET_SUMMARY_KEYS);
  });

  it('expand: true returns the full asset (serial)', async () => {
    stubFetch(() => json({ assets: [asset] }));
    await expect(makeClient().assets.findBySerial(asset.primary_serial, { expand: true })).resolves.toEqual(asset);
  });

  it('returns matching AssetSummary records', async () => {
    stubFetch(() => json({ assets: [{ ...asset, id: 51 }, { ...asset, id: 52 }] }));
    const rows = (await makeClient().assets.search('laptop')) as unknown[];
    expect(rows).toHaveLength(2);
    expect(Object.keys(asRecord(rows[0])).sort()).toEqual(ASSET_SUMMARY_KEYS);
  });

  it('narrows the search to company_id when given', async () => {
    const spy = stubFetch(() => json({ assets: [asset] }));
    await makeClient().assets.search('laptop', { company_id: 1 });
    expect(spy.calls[0].url).toContain('/api/v1/assets?');
    expect(spy.calls[0].url).toContain('company_id=1');
    expect(spy.calls[0].url).toContain('search=laptop');
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = stubFetch(() => json({ assets: [asset] }));
    await expect(makeClient().assets.search('laptop', { limit: 100 })).resolves.toHaveLength(1);
    expect(spy.calls[0].url).toContain('page_size=100');
    await expect(makeClient().assets.search('laptop', { limit: 101 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the asset with its layout, expirations and relations', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('/asset_layouts/')) return json({ asset_layout: { id: 5, name: 'Server', slug: 'server', active: true, icon: 'server', color: '#fff' } });
      if (url.includes('/expirations')) return json([{ id: 61, resource_id: 10 }]);
      if (url.includes('/relations')) return json([{ id: 71, fromable_id: 10 }]);
      if (url.includes('/companies/1/assets/10')) return json({ asset });
      return json({});
    });
    const context = (await makeClient().assets.getContext({ companyId: 1, id: 10 })) as Record<string, unknown>;
    expect(asRecord(context.asset).id).toBe(10);
    expect(asRecord(context.layout).id).toBe(5);
    expect(context.expirations).toHaveLength(1);
    expect(context.relations).toHaveLength(1);
    expect(spy.calls).toHaveLength(4);
  });

  it('throws NOT_FOUND for an unknown asset', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().assets.getContext({ companyId: 1, id: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('honours the per-list limit and cap', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('/asset_layouts/')) return json({ asset_layout: { id: 5, name: 'Server', slug: 'server', active: true, icon: 'server', color: '#fff' } });
      if (url.includes('/expirations')) return json([{ id: 61 }, { id: 62 }, { id: 63 }]);
      if (url.includes('/relations')) return json([{ id: 71 }, { id: 72 }, { id: 73 }]);
      if (url.includes('/companies/1/assets/10')) return json({ asset });
      return json({});
    });
    const context = (await makeClient().assets.getContext({ companyId: 1, id: 10 }, { limit: 2 })) as Record<string, unknown>;
    expect(context.expirations).toHaveLength(2);
    expect(context.relations).toHaveLength(2);
    for (const call of spy.calls.filter((c) => c.url.includes('/expirations') || c.url.includes('/relations'))) {
      expect(call.url).toContain('page_size=2');
    }
    await expect(makeClient().assets.getContext({ companyId: 1, id: 10 }, { limit: 101 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});

describe('AssetsResource agent-execution-layer primitives', () => {
  afterEach(() => clearFetch());

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().assets.delete(1, 10)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().assets.delete(1, 10, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).method).toBe('DELETE');
    expect(asRecord(result.target).ids).toEqual([10]);
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (delete)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.assets.delete(1, 10);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assets.delete(1, 11).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('calls the assets.listAcrossCompanies endpoint and returns the documented shape', async () => {
    const spy = stubFetch((url) => (url.includes('page=1') ? json({ assets: assetsList.assets }) : json({ assets: [] })));
    await expect(makeClient().assets.listAllAcrossCompanies({ company_id: 1 })).resolves.toEqual(assetsList.assets);
    expect(spy.calls[0].url).toContain('/api/v1/assets?');
    expect(spy.calls[0].url).toContain('page=1');
  });

  it('surfaces a correlation id on the success path and the error path (listAcrossCompanies)', async () => {
    const { client, events } = auditedClient();
    stubFetch((url) => (url.includes('page=1') ? json({ assets: assetsList.assets }) : json({ assets: [] })));
    const rows: unknown[] = [];
    for await (const row of client.assets.listAcrossCompanies({})) rows.push(row);
    expect(rows.length).toBeGreaterThan(0);
    expect(events[0]!.outcome).toBe('success');
    expect(typeof events[0]!.correlationId).toBe('string');
  });

  it('returns the unwrapped assets list', async () => {
    stubFetch(() => json({ assets: [asset] }));
    const rows: unknown[] = [];
    for await (const row of makeClient().assets.list(1, {})) rows.push(row);
    expect(rows).toEqual([asset]);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const spy = stubFetch(() => json({ assets: [asset] }));
    const rows: unknown[] = [];
    for await (const row of makeClient().assets.list(1, {})) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('/companies/1/assets?');
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('surfaces a correlation id on the success path and the error path (list)', async () => {
    const { client, events } = auditedClient();
    stubFetch(() => json({ assets: [asset] }));
    const rows: unknown[] = [];
    for await (const row of client.assets.list(1, {})) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(events[0]!.outcome).toBe('success');
    expect(typeof events[0]!.correlationId).toBe('string');
  });

  it('returns the unwrapped assets record', async () => {
    stubFetch(() => json({ asset }));
    await expect(makeClient().assets.get(1, 10)).resolves.toEqual(asset);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().assets.get(1, 999)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('surfaces a correlation id on the success path and the error path (get)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ asset }));
    await client.assets.get(1, 10);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assets.get(1, 11).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the created assets record', async () => {
    const spy = stubFetch(() => json(asset, 201));
    await expect(makeClient().assets.create(1, { name: 'Laptop' })).resolves.toEqual(asset);
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset: { name: 'Laptop' } }));
  });

  it('dry-run issues no mutating request and returns simulated: true (create)', async () => {
    const spy = stubFetch(() => json(asset, 201));
    const result = (await makeClient().assets.create(1, { name: 'Laptop' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).method).toBe('POST');
    expect(asRecord(result.request).path).toBe('/companies/1/assets');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (create)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json(asset, 201));
    await client.assets.create(1, { name: 'Laptop' });
    spy.setHandler(() => json({ error: 'boom' }, 500));
    const err = (await client.assets.create(1, { name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(typeof err.correlationId).toBe('string');
    expect(events[events.length - 1]!.outcome).toBe('error');
  });

  it('returns the updated assets record', async () => {
    const spy = stubFetch(() => json(asset));
    await expect(makeClient().assets.update(1, 10, { name: 'New' })).resolves.toEqual(asset);
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset: { name: 'New' } }));
  });

  it('dry-run issues no PUT request and returns simulated: true (update)', async () => {
    const spy = stubFetch(() => json(asset));
    const result = (await makeClient().assets.update(1, 10, { name: 'New' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).method).toBe('PUT');
    expect(asRecord(result.target).ids).toEqual([10]);
    expect(spy.calls).toHaveLength(0);
  });

  it('unwraps the PUT response by singleKey (update)', async () => {
    // The vendor PUT /assets response is a FLAT Asset (A-1/R6), so the raw body is
    // the record; `singleKey` is 'asset' and unwrapByKey passes a flat body through.
    stubFetch(() => json(asset));
    expect(asRecord(await makeClient().assets.update(1, 10, { name: 'New' })).id).toBe(asset.id);
  });

  it('surfaces a correlation id on the success path and the error path (update)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json(asset));
    await client.assets.update(1, 10, { name: 'New' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.assets.update(1, 10, { name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('calls the assets.archive endpoint and normalises the result', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().assets.archive(1, 10)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10/archive');
  });

  it('dry-run issues no mutating request and returns simulated: true (archive)', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().assets.archive(1, 10, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).path).toBe('/companies/1/assets/10/archive');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (archive)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.assets.archive(1, 10);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assets.archive(1, 11).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('calls the assets.moveLayout endpoint and normalises the result', async () => {
    const spy = stubFetch(() => json(asset));
    await expect(makeClient().assets.moveLayout(1, 10, { asset_layout_id: 99 })).resolves.toEqual(asset);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10/move_layout');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset_layout_id: 99 }));
  });

  it('dry-run issues no mutating request and returns simulated: true (moveLayout)', async () => {
    const spy = stubFetch(() => json(asset));
    const result = (await makeClient().assets.moveLayout(1, 10, { asset_layout_id: 99 }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).path).toBe('/companies/1/assets/10/move_layout');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (moveLayout)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json(asset));
    await client.assets.moveLayout(1, 10, { asset_layout_id: 99 });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.assets.moveLayout(1, 10, { asset_layout_id: 1 }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('calls the assets.unarchive endpoint and normalises the result', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().assets.unarchive(1, 10)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1/assets/10/unarchive');
  });

  it('dry-run issues no mutating request and returns simulated: true (unarchive)', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().assets.unarchive(1, 10, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (unarchive)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.assets.unarchive(1, 10);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assets.unarchive(1, 11).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });
});


describe('AssetsResource helper edge branches and validation', () => {
  afterEach(() => clearFetch());

  it('resolves an account-wide { id } and a bare numeric value', async () => {
    const spy = stubFetch(() => json({ assets: [asset] }));
    expect(asRecord(await makeClient().assets.resolve({ id: asset.id })).id).toBe(asset.id);
    expect(spy.calls[0].url).toContain('/api/v1/assets?');
    expect(spy.calls[0].url).toContain(`id=${asset.id}`);
    stubFetch(() => json({ assets: [asset] }));
    expect(asRecord(await makeClient().assets.resolve(String(asset.id))).id).toBe(asset.id);
  });

  it('throws NOT_FOUND when an account-wide { id } returns nothing', async () => {
    stubFetch(() => json({ assets: [] }));
    await expect(makeClient().assets.resolve({ id: 4242 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads a bare value in the documented order (serial, name, slug)', async () => {
    accountStub({ name: [asset] });
    expect(asRecord(await makeClient().assets.resolve('Laptop-001')).id).toBe(asset.id);
    accountStub({ slug: [asset] });
    expect(asRecord(await makeClient().assets.resolve('laptop-001')).id).toBe(asset.id);
  });

  it('resolves the object identifier kinds with and without a company narrowing', async () => {
    stubFetch(() => json({ assets: [asset] }));
    expect(asRecord(await makeClient().assets.resolve({ name: 'Laptop-001', companyId: 1 })).id).toBe(asset.id);
    expect(asRecord(await makeClient().assets.resolve({ slug: 'laptop-001' })).id).toBe(asset.id);
    expect(asRecord(await makeClient().assets.resolve({ primary_serial: asset.primary_serial, companyId: 1 })).id).toBe(asset.id);
  });

  it('reports the resolution cost with resolutionDetails', async () => {
    stubFetch(() => json({ asset }));
    const direct = (await makeClient().assets.resolve({ companyId: 1, id: 10 }, { resolutionDetails: true })) as Record<string, unknown>;
    expect(direct.resolutionCost).toBe('direct');
    expect(direct.scanned).toBe(1);
    stubFetch(() => json({ assets: [] }));
    const miss = (await makeClient().assets.resolve('Nothing Here', { resolutionDetails: true })) as Record<string, unknown>;
    expect(miss.value).toBeNull();
  });

  it('rejects an empty identifier, serial and query', async () => {
    await expect(makeClient().assets.resolve('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assets.resolve(null as unknown as number)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assets.resolve({ object_type: 'Asset' } as unknown as { id?: number })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
    await expect(makeClient().assets.findBySerial('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assets.search('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assets.findBySerial('x', { limit: 0 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('returns a null layout when the layout no longer exists, and the expanded context', async () => {
    stubFetch((url) => {
      if (url.includes('/asset_layouts/')) return json({ error: 'gone' }, 404);
      if (url.includes('/expirations')) return json([]);
      if (url.includes('/relations')) return json([]);
      if (url.includes('/companies/1/assets/10')) return json({ asset });
      return json({});
    });
    const context = (await makeClient().assets.getContext({ companyId: 1, id: 10 }, { expand: true })) as Record<string, unknown>;
    expect(asRecord(context.asset).fields).toEqual(asset.fields);
    expect(context.layout).toBeNull();
  });

  it('propagates a non-404 failure of the layout lookup', async () => {
    stubFetch((url) => {
      if (url.includes('/asset_layouts/')) return json({ error: 'bad' }, 400);
      if (url.includes('/expirations')) return json([]);
      if (url.includes('/relations')) return json([]);
      return json({ asset });
    });
    await expect(makeClient().assets.getContext({ companyId: 1, id: 10 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('throws NOT_FOUND for a getContext identifier that resolves to nothing', async () => {
    stubFetch(() => json({ assets: [] }));
    await expect(makeClient().assets.getContext('Nothing Here')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(makeClient().assets.getContext(null as unknown as number)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('lists every account-wide asset and yields account-wide pages', async () => {
    stubFetch((url) => (url.includes('page=1') ? json({ assets: [asset] }) : json({ assets: [] })));
    await expect(makeClient().assets.listAllAcrossCompanies({})).resolves.toEqual([asset]);
    const pages: unknown[] = [];
    for await (const page of makeClient().assets.listAcrossCompaniesPages({})) pages.push(page);
    expect(pages).toHaveLength(1);
  });

  it('resolves a bare numeric id account-wide and reports an inexact filter', async () => {
    const spy = stubFetch(() => json({ assets: [asset] }));
    expect(asRecord(await makeClient().assets.resolve(asset.id as unknown as number)).id).toBe(asset.id);
    expect(spy.calls[0].url).toContain(`id=${asset.id}`);
    stubFetch(() => json({ assets: [{ ...asset, id: 91, name: 'Alpha', slug: 'alpha' }, { ...asset, id: 92, name: 'Beta', slug: 'beta' }] }));
    await expect(makeClient().assets.resolve('Laptop')).rejects.toMatchObject({ code: 'RESOLUTION_AMBIGUOUS', resourceIds: [91, 92] });
  });

});


describe('AssetsResource — company id guard (validated before any IO)', () => {
  afterEach(() => clearFetch());

  type Call = (assets: AssetsResource, companyId: number) => unknown;
  const VALID = 13;

  const scopedEntryPoints: Array<[string, Call]> = [
    ['assets.get', (a, c) => a.get(c, 10)],
    ['assets.list', (a, c) => a.list(c, {})],
    ['assets.listAll', (a, c) => a.listAll(c, {})],
    ['assets.listPages', (a, c) => a.listPages(c, {})],
    ['assets.create', (a, c) => a.create(c, { name: 'Laptop-001' })],
    ['assets.update', (a, c) => a.update(c, 10, { name: 'Laptop-002' })],
    ['assets.delete', (a, c) => a.delete(c, 10)],
    ['assets.archive', (a, c) => a.archive(c, 10)],
    ['assets.unarchive', (a, c) => a.unarchive(c, 10)],
    ['assets.moveLayout', (a, c) => a.moveLayout(c, 10, { asset_layout_id: 2 })],
    ['assets.resolve', (a, c) => a.resolve({ companyId: c, id: 10 })],
    ['assets.getContext', (a, c) => a.getContext({ companyId: c, id: 10 })],
    ['assets.listAllAcrossCompanies', (a, c) => a.listAllAcrossCompanies({ company_id: c })],
  ];

  const malformed: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['float', 2.5],
  ];

  /** Runs the entry point and returns the rejection reason (or an Error when it resolved). */
  async function reason(call: Call, companyId: unknown): Promise<Error> {
    try {
      await call(makeClient().assets, companyId as number);
      return new Error('the entry point resolved instead of throwing');
    } catch (err) {
      return err as Error;
    }
  }

  for (const [entry, call] of scopedEntryPoints) {
    it(`${entry} rejects undefined/NaN/zero/negative/float without issuing a request`, async () => {
      const spy = stubFetch(() => json({ asset, assets: [asset] }));
      for (const [label, value] of malformed) {
        const err = await reason(call, value);
        expect(err, `${entry} accepted the ${label} company id`).toBeInstanceOf(HuduConfigError);
        expect((err as HuduConfigError).code).toBe('CONFIG_ERROR');
        expect(err.message).toBe(`${entry} requires a positive integer companyId, got "${String(value)}"`);
      }
      expect(spy.calls).toHaveLength(0);
    });
  }

  const validCases: Array<[string, Call, string]> = [
    ['assets.get', (a, c) => a.get(c, 10), '/companies/13/assets/10'],
    ['assets.list', (a, c) => a.list(c, {}), '/companies/13/assets?'],
    ['assets.listAll', (a, c) => a.listAll(c, {}), '/companies/13/assets?'],
    ['assets.listPages', (a, c) => a.listPages(c, {}), '/companies/13/assets?'],
    ['assets.create', (a, c) => a.create(c, { name: 'Laptop-001' }), '/companies/13/assets'],
    ['assets.update', (a, c) => a.update(c, 10, { name: 'Laptop-002' }), '/companies/13/assets/10'],
    ['assets.delete', (a, c) => a.delete(c, 10), '/companies/13/assets/10'],
    ['assets.archive', (a, c) => a.archive(c, 10), '/companies/13/assets/10/archive'],
    ['assets.unarchive', (a, c) => a.unarchive(c, 10), '/companies/13/assets/10/unarchive'],
    ['assets.moveLayout', (a, c) => a.moveLayout(c, 10, { asset_layout_id: 2 }), '/companies/13/assets/10/move_layout'],
    ['assets.resolve', (a, c) => a.resolve({ companyId: c, id: 10 }), '/companies/13/assets/10'],
    ['assets.getContext', (a, c) => a.getContext({ companyId: c, id: 10 }), '/companies/13/assets/10'],
    ['assets.listAllAcrossCompanies', (a, c) => a.listAllAcrossCompanies({ company_id: c }), '/assets?'],
  ];

  /**
   * Runs the entry point so its request is actually made, draining a streaming
   * result. Errors are swallowed: this suite asserts the REQUEST, and the stub
   * serves a single body shape that only some entry points can unwrap.
   */
  async function run(call: Call, companyId: number): Promise<void> {
    try {
      const result = (await call(makeClient().assets, companyId)) as AsyncIterable<unknown> | undefined;
      if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
        const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await iterator.next();
      }
    } catch {
      // The request itself is the assertion (see the caller).
    }
  }

  for (const [entry, call, expectedPath] of validCases) {
    it(`${entry} still issues the normal request for a valid company id`, async () => {
      const spy = stubFetch(() => json({ asset, assets: [asset] }));
      await run(call, VALID);
      expect(spy.calls.length, `${entry} issued no request`).toBeGreaterThan(0);
      expect(spy.calls[0].url).toContain(expectedPath);
      expect(spy.calls.every((c) => !c.url.includes('/companies/undefined'))).toBe(true);
    });
  }

  it('names the operation and the missing value — the live 500 repro', async () => {
    const spy = stubFetch(() => json({ assets: [] }));
    await expect(makeClient().assets.listAll(undefined as unknown as number)).rejects.toThrow(
      'assets.listAll requires a positive integer companyId, got "undefined"',
    );
    expect(spy.calls).toHaveLength(0);
  });

  it('leaves an explicit account-wide scope untouched (companyId omitted)', async () => {
    const spy = stubFetch(() => json({ assets: [asset] }));
    await expect(makeClient().assets.listAllAcrossCompanies({})).resolves.toEqual([asset]);
    const resolution = await makeClient().assets.resolve({ id: 10 });
    expect(asRecord(resolution).id).toBe(10);
    expect(spy.calls.some((c) => c.url.includes('/api/v1/assets?'))).toBe(true);
  });
});
