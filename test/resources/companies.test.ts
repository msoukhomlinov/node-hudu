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

  it('archive and unarchive hit the right URLs', async () => {
    const spy = stubFetch(() => empty(204));
    const r = makeClient().companies;
    await r.archive(3);
    await r.unarchive(3);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/companies/3/archive');
    expect(spy.calls[1].url).toBe('https://hudu.example.com/api/v1/companies/3/unarchive');
  });
});
