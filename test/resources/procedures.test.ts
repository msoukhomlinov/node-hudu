/**
 * ProceduresResource tests incl. special ops: duplicate/createFromTemplate/kickoff.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const procedure = JSON.parse(readFileSync(join(__dirname, '../__fixtures__/procedure.json'), 'utf8'));
const proceduresList = JSON.parse(readFileSync(join(__dirname, '../__fixtures__/procedures_list.json'), 'utf8'));

function makeClient() { return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }); }

describe('ProceduresResource', () => {
  afterEach(() => clearFetch());

  it('get unwraps the envelope', async () => {
    const spy = stubFetch(() => json({ procedure }));
    const res = await makeClient().procedures.get(5);
    expect(res).toEqual(procedure);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/procedures/5');
  });

  it('listAll collects pages', async () => {
    const spy = stubFetch(() => json(proceduresList));
    const res = await makeClient().procedures.listAll({ name: 'setup' });
    expect(res).toEqual(proceduresList.procedures);
    expect(spy.calls[0].url).toContain('name=setup');
  });

  it('list streams items and listPages yields page objects (B22)', async () => {
    stubFetch(() => json(proceduresList));
    const items: unknown[] = [];
    for await (const p of makeClient().procedures.list({ name: 'setup' })) items.push(p);
    expect(items).toEqual(proceduresList.procedures);
    const pages: unknown[] = [];
    for await (const pg of makeClient().procedures.listPages({})) pages.push(pg);
    expect((pages[0] as { items: unknown[] }).items).toEqual(proceduresList.procedures);
  });

  it('create (raw) returns the raw procedure', async () => {
    const spy = stubFetch(() => json(procedure, 201));
    const res = await makeClient().procedures.create({ name: 'Setup' });
    expect(res).toEqual(procedure);
    expect(spy.calls[0].init.method).toBe('POST');
  });

  it('update unwraps the { procedure } envelope', async () => {
    const spy = stubFetch(() => json({ procedure }));
    const res = await makeClient().procedures.update(5, { name: 'New' });
    expect(res).toEqual(procedure);
  });

  it('delete returns void (an empty 200 body is not mis-typed as { message }) (R4)', async () => {
    const spy = stubFetch(() => empty(200));
    const res = await makeClient().procedures.delete(5);
    expect(res).toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/procedures/5');
    expect(spy.calls[0].init.method).toBe('DELETE');
  });

  it('duplicate requires company_id (B15) and POSTs the query opts', async () => {
    const spy = stubFetch(() => json({ procedure }, 201));
    const res = await makeClient().procedures.duplicate(5, { company_id: 2, name: 'Copy', description: 'd' });
    expect(res).toEqual(procedure);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/procedures/5/duplicate?company_id=2&name=Copy&description=d');
    expect(spy.calls[0].init.method).toBe('POST');
  });

  it('createFromTemplate POSTs to /create_from_template and unwraps', async () => {
    const spy = stubFetch(() => json({ procedure }, 201));
    const res = await makeClient().procedures.createFromTemplate(9, { company_id: 3 });
    expect(res).toEqual(procedure);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/procedures/9/create_from_template?company_id=3');
  });

  it('kickoff POSTs to /kickoff and returns the message object', async () => {
    const spy = stubFetch(() => json({ message: 'Run started' }, 200));
    const res = await makeClient().procedures.kickoff(5, { asset_id: 2, name: 'Run 1' });
    expect(res).toEqual({ message: 'Run started' });
    expect(spy.calls[0].url).toContain('/procedures/5/kickoff');
    expect(spy.calls[0].url).toContain('asset_id=2');
    expect(spy.calls[0].url).toContain('name=Run+1');
  });
});
