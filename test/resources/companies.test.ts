/**
 * CompaniesResource tests with mocked envelopes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const company = JSON.parse(readFileSync(join(__dirname, '../__fixtures__/company.json'), 'utf8'));
const companiesList = JSON.parse(readFileSync(join(__dirname, '../__fixtures__/companies_list.json'), 'utf8'));

function makeClient() {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
}

describe('CompaniesResource', () => {
  afterEach(() => clearFetch());

  it('get returns the unwrapped company', async () => {
    const spy = stubFetch(() => json({ company }));
    const r = makeClient().companies;
    const res = await r.get(1);
    expect(res).toEqual(company);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1');
  });

  it('get propagates 404', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    const r = makeClient().companies;
    await expect(r.get(999)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('listAll collects a single page (short -> stop)', async () => {
    const spy = stubFetch((url, init) => json(companiesList));
    const r = makeClient().companies;
    const res = await r.listAll({ search: 'acme' });
    expect(res).toEqual(companiesList.companies);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('/api/v1/companies?');
    expect(spy.calls[0].url).toContain('search=acme');
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('listAll walks multiple pages until the page is short', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ ...company, id: i + 1, slug: 'c' + i }));
    const spy = stubFetch((url) => {
      if (url.includes('page=1')) return json({ companies: items });
      return json({ companies: [company] }); // short second page
    });
    const r = makeClient().companies;
    const res = await r.listAll({});
    expect(res).toHaveLength(26);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1].url).toContain('page=2');
  });

  it('list streams items across pages', async () => {
    stubFetch((url) => {
      if (url.includes('page=1')) return json({ companies: [company] });
      return json({ companies: [] });
    });
    const r = makeClient().companies;
    const items: unknown[] = [];
    for await (const c of r.list({})) items.push(c);
    expect(items).toHaveLength(1);
  });

  it('listPages yields page objects', async () => {
    stubFetch((url) => {
      if (url.includes('page=1')) return json({ companies: [company] });
      return json({ companies: [] });
    });
    const r = makeClient().companies;
    const pages: unknown[] = [];
    for await (const p of r.listPages({})) pages.push(p);
    expect(pages).toHaveLength(1);
    expect((pages[0] as { items: unknown[] }).items).toHaveLength(1);
  });

  it('create (raw) posts JSON and returns the raw company', async () => {
    const spy = stubFetch(() => json(company, 201));
    const r = makeClient().companies;
    const res = await r.create({ name: 'Acme Corp' });
    expect(res).toEqual(company);
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ name: 'Acme Corp' }));
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies');
  });

  it('update unwraps the { company } envelope', async () => {
    const spy = stubFetch(() => json({ company }));
    const r = makeClient().companies;
    const res = await r.update(1, { name: 'New Name' });
    expect(res).toEqual(company);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1');
    expect(spy.calls[0].init.method).toBe('PUT');
  });

  it('delete returns void on 204', async () => {
    const spy = stubFetch(() => empty(204));
    const r = makeClient().companies;
    await expect(r.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1');
    expect(spy.calls[0].init.method).toBe('DELETE');
  });

  it('jump follows the redirect and returns the Location (B21)', async () => {
    const spy = stubFetch(() =>
      new Response(null, { status: 302, headers: { location: 'https://hudu.example.com/companies/acme' } }),
    );
    const url = await makeClient().companies.jump({ integration_slug: 'hudu' });
    expect(url).toBe('https://hudu.example.com/companies/acme');
    expect(spy.calls[0].url).toContain('/companies/jump');
    expect(spy.calls[0].url).toContain('integration_slug=hudu');
  });

  it('archive and unarchive hit the right URLs', async () => {
    const spy = stubFetch(() => empty(204));
    const r = makeClient().companies;
    await r.archive(3);
    await r.unarchive(3);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/3/archive');
    expect(spy.calls[1].url).toBe('https://hudu.example.com/api/v1/companies/3/unarchive');
  });
});


// ---------------------------------------------------------------------------
// Agent-execution-layer rows (capabilities.plan.json, group A).
// Titles below are copied verbatim from the plan rows.
// ---------------------------------------------------------------------------

import type { AuditEvent } from '../../src/types/common.js';

const asRecord = (value: unknown) => value as Record<string, unknown>;

/** The full-record fixture the compact-shape tests project from. */
const full = company;

/** The 12 fields CompanySummary keeps; every other Company field is dropped. */
const COMPANY_SUMMARY_KEYS = [
  'archived', 'city', 'id', 'id_number', 'name', 'nickname',
  'phone_number', 'slug', 'state', 'updated_at', 'url', 'website',
].sort();

function cappedClient(maxScanRecords: number, maxScanPages: number) {
  return new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    resolution: { maxScanRecords, maxScanPages },
  });
}

function auditedClient() {
  const events: AuditEvent[] = [];
  const client = new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    onAudit: (event) => events.push(event),
  });
  return { client, events };
}

/** Answer by the first query key found in the URL, defaulting to no rows. */
function listStub(byFilter: Record<string, unknown[]>, fallback: unknown[] = []) {
  return stubFetch((url) => {
    for (const [key, rows] of Object.entries(byFilter)) {
      if (url.includes(`${key}=`)) return json({ companies: rows });
    }
    return json({ companies: fallback });
  });
}

function companiesPage(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, i) => ({ ...company, id: 100 + i, name: `Row ${i}`, ...overrides }));
}

describe('CompaniesResource agent-execution-layer helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ company }));
    const res = await makeClient().companies.resolve(1);
    expect(asRecord(res).id).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/1');
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'nope' }, 404));
    await expect(makeClient().companies.resolve({ id: 99 })).rejects.toMatchObject({ code: 'NOT_FOUND', category: 'not_found' });
  });

  it('returns the single exact match', async () => {
    const spy = listStub({ name: [full] });
    const res = await makeClient().companies.resolve('Acme Corp');
    expect(asRecord(res).id).toBe(1);
    // slug filter (empty), then the name filter (the match): no client scan.
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].url).toContain('slug=');
    expect(spy.calls[1].url).toContain('name=');
  });

  it('returns null after a complete scan', async () => {
    const spy = listStub({});
    await expect(makeClient().companies.resolve('Nothing Here')).resolves.toBeNull();
    // One server filter per documented kind: slug, exact name, domain.
    expect(spy.calls).toHaveLength(3);
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids when the filter is not exact', async () => {
    const rows = [
      { ...company, id: 11, name: 'Acme Corp' },
      { ...company, id: 12, name: 'Acme Limited' },
    ];
    listStub({ name: rows });
    await expect(makeClient().companies.resolve('Acme')).rejects.toMatchObject({
      code: 'RESOLUTION_AMBIGUOUS',
      category: 'resolution',
      resourceIds: [11, 12],
    });
  });

  it('throws RESOLUTION_TRUNCATED instead of null when the scan hits the cap', async () => {
    const spy = listStub({}, companiesPage(25));
    await expect(cappedClient(25, 1).companies.resolve('Nothing Here')).rejects.toMatchObject({
      code: 'RESOLUTION_TRUNCATED',
    });
    // The cap stopped the scan after one page; it did not walk on.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('page=1');
  });

  it('returns the compact shape and omits exactly the documented fields', async () => {
    stubFetch(() => json({ company }));
    const summary = asRecord(await makeClient().companies.resolve(1));
    expect(Object.keys(summary).sort()).toEqual(COMPANY_SUMMARY_KEYS);
    expect(summary.notes).toBeUndefined();
    expect(summary.created_at).toBeUndefined();
    expect(summary.integrations).toBeUndefined();
  });

  it('expand: true returns the full record', async () => {
    stubFetch(() => json({ company }));
    await expect(makeClient().companies.resolve(1, { expand: true })).resolves.toEqual(company);
  });

  it('returns the exact match', async () => {
    stubFetch(() => json({ companies: [full] }));
    const res = await makeClient().companies.findByDomain('acme.example.com');
    expect(asRecord(res).id).toBe(1);
  });

  it('returns null after a complete scan', async () => {
    stubFetch(() => json({ companies: [] }));
    await expect(makeClient().companies.findByDomain('nowhere.example')).resolves.toBeNull();
  });

  it('throws RESOLUTION_AMBIGUOUS when several companies share the domain', async () => {
    const rows = [
      { ...company, id: 21, website: 'https://dup.example.com' },
      { ...company, id: 22, website: 'https://www.dup.example.com' },
    ];
    stubFetch(() => json({ companies: rows }));
    await expect(makeClient().companies.findByDomain('dup.example.com')).rejects.toMatchObject({
      code: 'RESOLUTION_AMBIGUOUS',
      resourceIds: [21, 22],
    });
  });

  it('throws RESOLUTION_TRUNCATED when the cap is reached', async () => {
    const spy = stubFetch(() => json({ companies: companiesPage(25, { website: 'https://other.example' }) }));
    await expect(cappedClient(25, 1).companies.findByDomain('dup.example.com')).rejects.toMatchObject({
      code: 'RESOLUTION_TRUNCATED',
    });
    expect(spy.calls).toHaveLength(1);
  });

  it('returns CompanySummary and omits exactly the documented fields', async () => {
    stubFetch(() => json({ companies: [full] }));
    const summary = asRecord(await makeClient().companies.findByDomain('acme.example.com'));
    expect(Object.keys(summary).sort()).toEqual(COMPANY_SUMMARY_KEYS);
    expect(summary.address_line_1).toBeUndefined();
    expect(summary.company_type).toBeUndefined();
  });

  it('expand: true returns the full company record', async () => {
    stubFetch(() => json({ companies: [full] }));
    await expect(makeClient().companies.findByDomain('acme.example.com', { expand: true })).resolves.toEqual(company);
  });

  it('returns the exact match (slug)', async () => {
    stubFetch(() => json({ companies: [full] }));
    expect(asRecord(await makeClient().companies.findBySlug('acme-corp')).slug).toBe('acme-corp');
  });

  it('returns null after a complete scan (slug)', async () => {
    stubFetch(() => json({ companies: [] }));
    await expect(makeClient().companies.findBySlug('missing')).resolves.toBeNull();
  });

  it('returns CompanySummary', async () => {
    stubFetch(() => json({ companies: [full] }));
    expect(Object.keys(asRecord(await makeClient().companies.findBySlug('acme-corp'))).sort()).toEqual(COMPANY_SUMMARY_KEYS);
  });

  it('expand: true returns the full company record (slug)', async () => {
    stubFetch(() => json({ companies: [full] }));
    await expect(makeClient().companies.findBySlug('acme-corp', { expand: true })).resolves.toEqual(company);
  });

  it('returns the matching companies as CompanySummary', async () => {
    stubFetch(() => json({ companies: [{ ...company, id: 31 }, { ...company, id: 32 }] }));
    const rows = (await makeClient().companies.search('acme')) as unknown[];
    expect(rows).toHaveLength(2);
    expect(asRecord(rows[0]).id).toBe(31);
    expect(Object.keys(asRecord(rows[0])).sort()).toEqual(COMPANY_SUMMARY_KEYS);
  });

  it('honours limit and never exceeds the maximum of 100', async () => {
    const spy = stubFetch(() => json({ companies: [full] }));
    await expect(makeClient().companies.search('acme', { limit: 100 })).resolves.toHaveLength(1);
    expect(spy.calls[0].url).toContain('page_size=100');
    expect(spy.calls).toHaveLength(1);
    await expect(makeClient().companies.search('acme', { limit: 101 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(spy.calls).toHaveLength(1);
  });

  it('expand: true returns full company records', async () => {
    stubFetch(() => json({ companies: [full] }));
    await expect(makeClient().companies.search('acme', { expand: true })).resolves.toEqual([company]);
  });

  it('returns the context bundle with bounded sub-lists', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('/asset_passwords')) return json({ asset_passwords: [{ id: 51 }] });
      if (url.includes('/articles')) return json({ articles: [{ id: 41 }] });
      if (url.includes('/websites')) return json([{ id: 61 }]);
      if (url.includes('/assets')) return json({ assets: [{ id: 71 }] });
      return json({ company });
    });
    const context = (await makeClient().companies.getContext(1)) as {
      company: Record<string, unknown>;
      assets: unknown[];
      articles: unknown[];
      websites: unknown[];
      assetPasswords: unknown[];
    };
    expect(context.company.id).toBe(1);
    expect(context.assets).toHaveLength(1);
    expect(context.articles).toHaveLength(1);
    expect(context.websites).toHaveLength(1);
    expect(context.assetPasswords).toHaveLength(1);
    // Four bounded sub-fetches plus the company read: nothing pages the account.
    expect(spy.calls).toHaveLength(5);
    for (const call of spy.calls.slice(1)) expect(call.url).toContain('page_size=25');
  });

  it('throws NOT_FOUND for an unknown company id', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().companies.getContext(999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('honours the per-list limit and cap', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('/asset_passwords')) return json({ asset_passwords: [{ id: 51 }, { id: 52 }, { id: 53 }] });
      if (url.includes('/articles')) return json({ articles: [{ id: 41 }, { id: 42 }, { id: 43 }] });
      if (url.includes('/websites')) return json([{ id: 61 }, { id: 62 }, { id: 63 }]);
      if (url.includes('/assets')) return json({ assets: [{ id: 71 }, { id: 72 }, { id: 73 }] });
      return json({ company });
    });
    const context = (await makeClient().companies.getContext(1, { limit: 2 })) as {
      assets: unknown[];
      articles: unknown[];
      websites: unknown[];
      assetPasswords: unknown[];
    };
    expect(context.assets).toHaveLength(2);
    expect(context.articles).toHaveLength(2);
    expect(context.websites).toHaveLength(2);
    expect(context.assetPasswords).toHaveLength(2);
    for (const call of spy.calls.slice(1)) expect(call.url).toContain('page_size=2');
    await expect(makeClient().companies.getContext(1, { limit: 101 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});

describe('CompaniesResource agent-execution-layer primitives', () => {
  afterEach(() => clearFetch());

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().companies.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().companies.delete(1, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(result.wouldApply).toBe(true);
    expect(asRecord(result.request).method).toBe('DELETE');
    expect(asRecord(result.request).path).toBe('/companies/1');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.companies.delete(1);
    expect(events).toHaveLength(1);
    expect(typeof events[0]!.correlationId).toBe('string');
    expect(events[0]!.correlationId.length).toBeGreaterThan(0);
    expect(events[0]!.outcome).toBe('success');
    spy.setHandler(() => json({ error: 'gone' }, 404));
    const err = (await client.companies.delete(2).catch((e: unknown) => e)) as { correlationId?: string; code?: string };
    expect(err.code).toBe('NOT_FOUND');
    expect(typeof err.correlationId).toBe('string');
    expect(events).toHaveLength(2);
    expect(events[1]!.outcome).toBe('error');
    expect(events[1]!.correlationId).toBe(err.correlationId);
  });

  it('returns the unwrapped companies list', async () => {
    stubFetch(() => json(companiesList));
    const rows: unknown[] = [];
    for await (const row of makeClient().companies.list({})) rows.push(row);
    expect(rows).toEqual(companiesList.companies);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const spy = stubFetch((url) => (url.includes('page=1') ? json(companiesList) : json({ companies: [] })));
    const rows: unknown[] = [];
    for await (const row of makeClient().companies.list({ search: 'a' })) rows.push(row);
    expect(rows.length).toBeGreaterThan(0);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('surfaces a correlation id on the success path and the error path (list)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json(companiesList));
    const rows: unknown[] = [];
    for await (const row of client.companies.list({})) rows.push(row);
    expect(rows).toHaveLength(companiesList.companies.length);
    expect(events[0]!.outcome).toBe('success');
    spy.setHandler(() => json({ error: 'boom' }, 500));
    const err = (await (async () => {
      for await (const _row of client.companies.list({})) void _row;
    })().catch((e: unknown) => e)) as { correlationId?: string };
    expect(typeof err.correlationId).toBe('string');
    expect(events[events.length - 1]!.outcome).toBe('error');
  });

  it('returns the unwrapped companies record', async () => {
    stubFetch(() => json({ company }));
    await expect(makeClient().companies.get(1)).resolves.toEqual(company);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().companies.get(999)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('surfaces a correlation id on the success path and the error path (get)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ company }));
    await client.companies.get(1);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.companies.get(2).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(events[1]!.outcome).toBe('error');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('calls the companies.jump endpoint and returns the documented shape', async () => {
    const spy = stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://hudu.example.com/companies/acme-corp' } }));
    await expect(makeClient().companies.jump({ integration_slug: 'hudu' })).resolves.toBe('https://hudu.example.com/companies/acme-corp');
    expect(spy.calls[0].url).toContain('/companies/jump');
  });

  it('surfaces a correlation id on the success path and the error path (jump)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://hudu.example.com/x' } }));
    await client.companies.jump({ integration_slug: 'hudu' });
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.companies.jump({ integration_slug: 'hudu' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(typeof err.correlationId).toBe('string');
    expect(events[events.length - 1]!.outcome).toBe('error');
  });

  it('returns the created companies record', async () => {
    const spy = stubFetch(() => json(company, 201));
    await expect(makeClient().companies.create({ name: 'Acme Corp' })).resolves.toEqual(company);
    expect(spy.calls[0].init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(company, 201));
    const result = (await makeClient().companies.create({ name: 'Acme Corp' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).method).toBe('POST');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (create)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json(company, 201));
    await client.companies.create({ name: 'Acme Corp' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.companies.create({ name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the updated companies record', async () => {
    const spy = stubFetch(() => json({ company }));
    await expect(makeClient().companies.update(1, { name: 'New' })).resolves.toEqual(company);
    expect(spy.calls[0].init.method).toBe('PUT');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ company }));
    const result = (await makeClient().companies.update(1, { name: 'New' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).method).toBe('PUT');
    expect(asRecord(result.target).ids).toEqual([1]);
    expect(spy.calls).toHaveLength(0);
  });

  it('unwraps the PUT response by singleKey', async () => {
    stubFetch(() => json({ company }));
    expect(asRecord(await makeClient().companies.update(1, { name: 'New' })).id).toBe(1);
  });

  it('surfaces a correlation id on the success path and the error path (update)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ company }));
    await client.companies.update(1, { name: 'New' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.companies.update(1, { name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT (update)', async () => {
    const spy = stubFetch((url) => (url.includes('/companies/1') && url.includes('/companies/1') && !url.includes('?')
      ? json({ company })
      : json({ company })));
    spy.setHandler((url, init) => (init.method === 'GET' ? json({ company }) : json({ company })));
    // Match: the guard reads the record and the PUT proceeds.
    await expect(makeClient().companies.update(1, { name: 'New' }, { expectedUpdatedAt: company.updated_at })).resolves.toEqual(company);
    expect(spy.calls[0].init.method).toBe('GET');
    expect(spy.calls[1].init.method).toBe('PUT');
    // Mismatch: the guard throws STALE_OBJECT before any PUT is issued.
    spy.calls.length = 0;
    await expect(
      makeClient().companies.update(1, { name: 'New' }, { expectedUpdatedAt: '1999-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'STALE_OBJECT', category: 'conflict', retryable: false });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].init.method).toBe('GET');
  });

  it('calls the companies.archive endpoint and normalises the result', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().companies.archive(7)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/7/archive');
  });

  it('dry-run issues no mutating request and returns simulated: true (archive)', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().companies.archive(7, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).path).toBe('/companies/7/archive');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (archive)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.companies.archive(7);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.companies.archive(8).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('calls the companies.unarchive endpoint and normalises the result', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().companies.unarchive(7)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/7/unarchive');
  });

  it('dry-run issues no mutating request and returns simulated: true (unarchive)', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().companies.unarchive(7, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).path).toBe('/companies/7/unarchive');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (unarchive)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.companies.unarchive(7);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.companies.unarchive(8).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });
});


describe('CompaniesResource helper edge branches and validation', () => {
  afterEach(() => clearFetch());

  it('reads a bare numeric value and a bare slug/domain in the documented order', async () => {
    const byId = stubFetch(() => json({ company }));
    expect(asRecord(await makeClient().companies.resolve('12')).id).toBe(1);
    expect(byId.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/12');
    // slug filter matches exactly.
    stubFetch(() => json({ companies: [full] }));
    expect(asRecord(await makeClient().companies.resolve('acme-corp')).slug).toBe('acme-corp');
    // no slug and no name, then the domain filter matches.
    listStub({ website: [full] });
    expect(asRecord(await makeClient().companies.resolve('acme.example.com')).id).toBe(1);
  });

  it('resolves the object identifier kinds', async () => {
    stubFetch(() => json({ companies: [full] }));
    expect(asRecord(await makeClient().companies.resolve({ slug: 'acme-corp' })).id).toBe(1);
    expect(asRecord(await makeClient().companies.resolve({ name: 'Acme Corp' })).id).toBe(1);
    expect(asRecord(await makeClient().companies.resolve({ website: 'https://acme.example.com' })).id).toBe(1);
    expect(asRecord(await makeClient().companies.resolve({ domain: 'acme.example.com' })).id).toBe(1);
  });

  it('reports the resolution cost and scanned count with resolutionDetails', async () => {
    stubFetch(() => json({ company }));
    const direct = (await makeClient().companies.resolve(1, { resolutionDetails: true })) as Record<string, unknown>;
    expect(direct.resolutionCost).toBe('direct');
    expect(direct.scanned).toBe(1);
    expect(direct.scanTruncated).toBe(false);
    expect(asRecord(direct.value).id).toBe(1);
    const expanded = (await makeClient().companies.resolve(1, { resolutionDetails: true, expand: true })) as Record<string, unknown>;
    expect(asRecord(expanded.value).notes).toBe('');
    stubFetch(() => json({ companies: [] }));
    const miss = (await makeClient().companies.resolve('Nope', { resolutionDetails: true })) as Record<string, unknown>;
    expect(miss.value).toBeNull();
    expect(miss.scanTruncated).toBe(false);
    expect(miss.resolutionCost).toBe('server-filter');
  });

  it('rejects an empty or unsupported identifier with a structured validation error', async () => {
    await expect(makeClient().companies.resolve('')).rejects.toMatchObject({ code: 'CONFIG_ERROR', category: 'validation' });
    await expect(makeClient().companies.resolve(null as unknown as number)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().companies.resolve({ external_id: 'x' } as unknown as { id?: number })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
  });

  it('rejects an empty domain, slug and search query', async () => {
    await expect(makeClient().companies.findByDomain('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().companies.findBySlug('   ')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().companies.search('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('rejects a non-positive and a non-integer limit', async () => {
    await expect(makeClient().companies.search('acme', { limit: 0 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().companies.search('acme', { limit: 1.5 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().companies.findByDomain('acme.example.com', { limit: 101 })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
  });

  it('returns the expanded context when expand: true', async () => {
    stubFetch((url) => {
      if (url.includes('/asset_passwords')) return json({ asset_passwords: [{ id: 51 }] });
      if (url.includes('/articles')) return json({ articles: [{ id: 41 }] });
      if (url.includes('/websites')) return json([{ id: 61 }]);
      if (url.includes('/assets')) return json({ assets: [{ id: 71 }] });
      return json({ company });
    });
    const context = (await makeClient().companies.getContext(1, { expand: true })) as Record<string, unknown>;
    expect(asRecord(context.company).notes).toBe('');
    expect(asRecord((context.assets as unknown[])[0]).id).toBe(71);
  });

  it('treats a non-string website as an unmatched host', async () => {
    stubFetch(() => json({ companies: [{ ...company, website: null }] }));
    await expect(makeClient().companies.findByDomain('acme.example.com')).resolves.toBeNull();
  });

  it('rejects an empty website identifier', async () => {
    await expect(makeClient().companies.resolve({ website: '   ' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

});
