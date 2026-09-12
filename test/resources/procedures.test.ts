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


/**
 * Agent-execution-layer contract for ProceduresResource: the dry-run/stale/correlation
 * contract on every mutation, the `resolve` helper floor and the composite
 * `getWithTasks`. The `it(...)` titles are asserted verbatim by `capabilities:check`
 * against the `procedures` rows of capabilities.plan.json.
 */
import { HuduConfigError, HuduError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH = '/api/v1/procedures';
const TASKS_PATH = '/api/v1/procedure_tasks';

function auditSpy() {
  const events: AuditEvent[] = [];
  return { events, onAudit: (event: AuditEvent) => { events.push(event); } };
}

function clientWith(extra: Record<string, unknown> = {}) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...extra });
}

async function rejection(promise: Promise<unknown>): Promise<HuduError> {
  try {
    await promise;
  } catch (err) {
    return err as HuduError;
  }
  throw new Error('expected the call to reject');
}

/** Serve `items` through the paginated /procedures endpoint, 25 per page. */
function procedurePages(items: unknown[]): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    return json({ procedures: items.slice((page - 1) * size, page * size) });
  };
}

function routed(routes: Record<string, (url: URL) => Response>) {
  return stubFetch((raw) => {
    const url = new URL(raw);
    const handler = routes[url.pathname];
    if (handler === undefined) throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    return handler(url);
  });
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    name: 'Check backups',
    description: 'YmFzZTY0',
    position: 2,
    priority: 'normal',
    completed: false,
    completed_date: '',
    completion_notes: '',
    due_date: '2024-06-01',
    formatted_due_date: 'Jun 1, 2024',
    user_id: 2,
    user_name: 'Tech',
    assigned_users: [2],
    first_assigned_user_id: 2,
    first_assigned_user_name: 'Tech',
    first_assigned_user_initials: 'T',
    procedure_id: 5,
    optional: false,
    parent_task_id: null,
    subtask_ids: [],
    subtask_count: 0,
    has_subtasks: false,
    url: 'https://hudu.example.com/tasks/5',
    created_at: '2024-04-01T00:00:00Z',
    updated_at: '2024-05-01T00:00:00Z',
    ...overrides,
  };
}

describe('ProceduresResource — agent execution layer', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped procedures list', async () => {
    const spy = routed({ [PATH]: procedurePages([procedure]) });
    await expect(clientWith().procedures.listAll({ name: 'setup' })).resolves.toEqual([procedure]);
    expect(spy.calls[0]?.url).toContain('/api/v1/procedures');
    expect(spy.calls[0]?.url).toContain('name=setup');
  });

  it('sends page/page_size and stops on a short page', async () => {
    const many = Array.from({ length: 30 }, (_v, index) => ({ ...procedure, id: index + 1 }));
    const spy = routed({ [PATH]: procedurePages(many) });
    const res = await clientWith().procedures.listAll({});
    expect(res).toHaveLength(30);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.url).toContain('page=1');
    expect(spy.calls[0]?.url).toContain('page_size=25');
    expect(spy.calls[1]?.url).toContain('page=2');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [PATH]: procedurePages([procedure]) });
    const client = clientWith({ onAudit: audit.onAudit });
    await client.procedures.listAll({});
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('procedures.list');
    spy.setHandler(() => json({ message: 'nope' }, 401));
    const err = await rejection(client.procedures.listAll({}));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the unwrapped procedures record', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure }) });
    await expect(clientWith().procedures.get(5)).resolves.toEqual(procedure);
    expect(spy.calls[0]?.url).toBe(`https://hudu.example.com${PATH}/5`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    routed({ [`${PATH}/5`]: () => json({ message: 'missing' }, 404) });
    const err = await rejection(clientWith().procedures.get(5));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure }) });
    const client = clientWith({ onAudit: audit.onAudit });
    await client.procedures.get(5);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('procedures.get');
    spy.setHandler(() => json({ message: 'missing' }, 404));
    const err = await rejection(client.procedures.get(5));
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the created procedures record', async () => {
    const spy = routed({ [PATH]: () => json(procedure, 201) });
    await expect(clientWith().procedures.create({ name: 'Setup' })).resolves.toEqual(procedure);
    expect(spy.calls[0]?.init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await clientWith().procedures.create({ name: 'Setup' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'procedures.create',
      request: { method: 'POST', path: '/procedures' },
      simulated: true,
      wouldApply: true,
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [PATH]: () => json(procedure, 201) });
    const client = clientWith({ onAudit: audit.onAudit });
    await client.procedures.create({ name: 'Setup' });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('procedures.create');
    spy.setHandler(() => json({ message: 'invalid' }, 422));
    const err = await rejection(client.procedures.create({ name: '' }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

    it('calls the procedures.createFromTemplate endpoint and normalises the result', async () => {
    const spy = routed({ [`${PATH}/9/create_from_template`]: () => json({ procedure }, 201) });
    await expect(clientWith().procedures.createFromTemplate(9, { company_id: 3 })).resolves.toEqual(procedure);
    expect(spy.calls[0]?.init.method).toBe('POST');
    expect(spy.calls[0]?.url).toBe(`https://hudu.example.com${PATH}/9/create_from_template?company_id=3`);
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await clientWith().procedures.createFromTemplate(9, { company_id: 3 }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'procedures.createFromTemplate',
      request: { method: 'POST', path: '/procedures/9/create_from_template' },
      target: { resource: 'procedures', ids: [9] },
      simulated: true,
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/9/create_from_template`]: () => json({ procedure }, 201) });
    const client = clientWith({ onAudit: audit.onAudit });
    await client.procedures.createFromTemplate(9, { company_id: 3 });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('procedures.createFromTemplate');
    spy.setHandler(() => json({ message: 'gone' }, 404));
    const err = await rejection(client.procedures.createFromTemplate(9, { company_id: 3 }));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

  it('calls the procedures.duplicate endpoint and normalises the result', async () => {
    const spy = routed({ [`${PATH}/5/duplicate`]: () => json({ procedure }, 201) });
    await expect(clientWith().procedures.duplicate(5, { company_id: 2, name: 'Copy' })).resolves.toEqual(procedure);
    expect(spy.calls[0]?.init.method).toBe('POST');
    expect(spy.calls[0]?.url).toBe(`https://hudu.example.com${PATH}/5/duplicate?company_id=2&name=Copy`);
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await clientWith().procedures.duplicate(5, { company_id: 2 }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'procedures.duplicate',
      request: { method: 'POST', path: '/procedures/5/duplicate' },
      simulated: true,
    });
    expect(result.checks).toEqual([
      { name: 'target-identifier', ok: true, detail: 'target 5' },
      { name: 'company-bound', ok: true, detail: 'target company 2' },
    ]);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/5/duplicate`]: () => json({ procedure }, 201) });
    const client = clientWith({ onAudit: audit.onAudit });
    await client.procedures.duplicate(5, { company_id: 2 });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'invalid' }, 422));
    const err = await rejection(client.procedures.duplicate(5, { company_id: 2 }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

  it('calls the procedures.kickoff endpoint and normalises the result', async () => {
    const spy = routed({ [`${PATH}/5/kickoff`]: () => json({ message: 'Run started' }) });
    await expect(clientWith().procedures.kickoff(5, { asset_id: 2 })).resolves.toEqual({ message: 'Run started' });
    expect(spy.calls[0]?.url).toBe(`https://hudu.example.com${PATH}/5/kickoff?asset_id=2`);
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await clientWith().procedures.kickoff(5, { asset_id: 2 }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'procedures.kickoff',
      request: { method: 'POST', path: '/procedures/5/kickoff' },
      simulated: true,
    });
    // kickoff answers { message }, not a Procedure: the dry-run pins that type.
    expect(result.__recordType).toBeUndefined();
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/5/kickoff`]: () => json({ message: 'ok' }) });
    const client = clientWith({ onAudit: audit.onAudit });
    await client.procedures.kickoff(5);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'no such process' }, 404));
    const err = await rejection(client.procedures.kickoff(5));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the updated procedures record', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure }) });
    await expect(clientWith().procedures.update(5, { name: 'New' })).resolves.toEqual(procedure);
    expect(spy.calls[0]?.init.method).toBe('PUT');
    expect(spy.calls[0]?.init.body).toBe(JSON.stringify({ name: 'New' }));
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await clientWith().procedures.update(5, { name: 'New' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'procedures.update',
      request: { method: 'PUT', path: '/procedures/5' },
      target: { resource: 'procedures', ids: [5] },
      simulated: true,
    });
  });

  it('unwraps the PUT response by singleKey', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure, extra: 1 }) });
    await expect(clientWith().procedures.update(5, { name: 'New' })).resolves.toEqual(procedure);
    expect(spy.calls).toHaveLength(1);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure }) });
    const client = clientWith({ onAudit: audit.onAudit });
    await client.procedures.update(5, { name: 'New' });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('procedures.update');
    spy.setHandler(() => json({ message: 'invalid' }, 422));
    const err = await rejection(client.procedures.update(5, { name: '' }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure }) });
    const err = await rejection(
      clientWith().procedures.update(5, { name: 'New' }, { expectedUpdatedAt: '1999-01-01T00:00:00Z' }),
    );
    expect(err.code).toBe('STALE_OBJECT');
    expect(err.category).toBe('conflict');
    expect(err.resourceIds).toEqual([5]);
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET']);
    const ok = routed({ [`${PATH}/5`]: () => json({ procedure }) });
    ok.setHandler((_raw, init) => (init.method === 'PUT' ? json({ procedure }) : json({ procedure })));
    await clientWith().procedures.update(5, { name: 'New' }, { expectedUpdatedAt: procedure.updated_at });
    expect(ok.calls.map((call) => call.init.method)).toEqual(['GET', 'PUT']);
  });

  it('resolves void after a successful delete', async () => {
    const spy = routed({ [`${PATH}/5`]: () => empty(200) });
    await expect(clientWith().procedures.delete(5)).resolves.toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
    expect(spy.calls[0]?.url).toBe(`https://hudu.example.com${PATH}/5`);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await clientWith().procedures.delete(5, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'procedures.delete',
      request: { method: 'DELETE', path: '/procedures/5' },
      impact: { scope: 'single', reversible: false },
      simulated: true,
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/5`]: () => empty(200) });
    const client = clientWith({ onAudit: audit.onAudit });
    await client.procedures.delete(5);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.effect).toBe('destructive');
    spy.setHandler(() => json({ message: 'missing' }, 404));
    const err = await rejection(client.procedures.delete(5));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

    it('fetches by id without a scan', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure }) });
    const res = await clientWith().procedures.resolve(5);
    expect(res).toMatchObject({ id: 5, name: procedure.name });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toBe(`https://hudu.example.com${PATH}/5`);
    const detailed = await clientWith().procedures.resolve('5', { resolutionDetails: true });
    expect(detailed).toMatchObject({ resolutionCost: 'direct', scanned: 1, scanTruncated: false });
    expect(detailed.candidates).toEqual([{ id: 5, label: procedure.name }]);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    routed({ [`${PATH}/999`]: () => json({ message: 'missing' }, 404) });
    const err = await rejection(clientWith().procedures.resolve({ id: 999 }));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('returns the single exact match', async () => {
    const spy = routed({ [PATH]: procedurePages([procedure, { ...procedure, id: 6, slug: 'other' }]) });
    const res = await clientWith().procedures.resolve({ slug: procedure.slug });
    expect(res).toMatchObject({ id: 5 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('slug=');
    // A name lookup narrows with company_id; the server returns the one company-scoped match.
    const byNameSpy = routed({ [PATH]: procedurePages([procedure]) });
    const byName = await clientWith().procedures.resolve({ name: procedure.name, company_id: 3 });
    expect(byName).toMatchObject({ id: 5 });
    expect(byNameSpy.calls[0]?.url).toContain('company_id=3');
  });

  it('returns null after a complete scan', async () => {
    const spy = routed({ [PATH]: procedurePages([]) });
    await expect(clientWith().procedures.resolve('no such process')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(2);
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids', async () => {
    routed({ [PATH]: procedurePages([procedure, { ...procedure, id: 6 }]) });
    const err = await rejection(clientWith().procedures.resolve({ name: procedure.name }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.category).toBe('resolution');
    expect(err.resourceIds).toEqual([5, 6]);
    expect(err.retryable).toBe(false);
  });

  it('returns ProcedureSummary', async () => {
    routed({ [`${PATH}/5`]: () => json({ procedure }) });
    const summary = await clientWith().procedures.resolve(5);
    expect(summary).toEqual({
      id: 5,
      name: procedure.name,
      slug: procedure.slug,
      company_id: procedure.company_id,
      company_name: procedure.company_name,
      status: procedure.status,
      total: procedure.total,
      completed: procedure.completed,
      completion_percentage: procedure.completion_percentage,
      process_type: procedure.process_type,
      url: procedure.url,
      updated_at: procedure.updated_at,
    });
    for (const dropped of ['description', 'object_type', 'created_at', 'parent_procedure', 'run', 'parent_process_id', 'asset', 'share_url', 'procedure_tasks_attributes']) {
      expect(summary, dropped).not.toHaveProperty(dropped);
    }
    await expect(clientWith().procedures.resolve('unknown', { limit: 101 })).rejects.toThrow(HuduConfigError);
    await expect(clientWith().procedures.resolve('unknown', { limit: 0 })).rejects.toThrow(HuduConfigError);
  });

  it('expand: true returns the full procedure', async () => {
    routed({ [`${PATH}/5`]: () => json({ procedure }) });
    await expect(clientWith().procedures.resolve(5, { expand: true })).resolves.toEqual(procedure);
  });

  it('returns the procedure plus its tasks in one call', async () => {
    const spy = routed({
      [`${PATH}/5`]: () => json({ procedure }),
      [TASKS_PATH]: () => json({ procedure_tasks: [task()] }),
    });
    const result = await clientWith().procedures.getWithTasks(5);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1]?.url).toContain('procedure_id=5');
    expect(spy.calls[1]?.url).not.toContain('page=');
    expect(result.procedure).toMatchObject({ id: 5, name: procedure.name });
    expect(result.task_count).toBe(1);
    expect(result.tasks[0]).toMatchObject({ id: 5, name: 'Check backups', procedure_id: 5 });
    expect(result.tasks[0]).not.toHaveProperty('description');
    const expanded = await clientWith().procedures.getWithTasks(5, { expand: true });
    expect(spy.calls).toHaveLength(4);
    expect(expanded.procedure).toEqual(procedure);
    expect(expanded.tasks[0]).toEqual(task());
    expect(expanded.limit).toBe(25);
  });

  it('throws NOT_FOUND for an unknown procedure id', async () => {
    routed({ [`${PATH}/999`]: () => json({ message: 'missing' }, 404) });
    const err = await rejection(clientWith().procedures.getWithTasks(999));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('bounds the task list and never exceeds 100', async () => {
    const many = Array.from({ length: 120 }, (_v, index) => task({ id: index + 1 }));
    const spy = routed({
      [`${PATH}/5`]: () => json({ procedure }),
      [TASKS_PATH]: () => json({ procedure_tasks: many }),
    });
    const client = clientWith();
    const result = await client.procedures.getWithTasks(5, { limit: 100 });
    expect(result.tasks).toHaveLength(100);
    expect(result.task_count).toBe(100);
    const small = await client.procedures.getWithTasks(5, { limit: 3 });
    expect(small.tasks).toHaveLength(3);
    await expect(client.procedures.getWithTasks(5, { limit: 101 })).rejects.toThrow(HuduConfigError);
    expect(spy.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('ProceduresResource — resolution edge cases', () => {
  afterEach(() => clearFetch());

  it('rejects identifier kinds the vendor cannot filter on', async () => {
    const spy = routed({});
    const client = clientWith();
    await expect(client.procedures.resolve('')).rejects.toThrow(HuduConfigError);
    await expect(client.procedures.resolve({})).rejects.toThrow(HuduConfigError);
    await expect(client.procedures.resolve({ id: 0 })).rejects.toThrow(HuduConfigError);
    await expect(client.procedures.resolve({ slug: '  ' })).rejects.toThrow(HuduConfigError);
    await expect(client.procedures.resolve(null as never)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('falls back from slug to name for a bare value and resolves either way', async () => {
    const spy = routed({ [PATH]: procedurePages([{ ...procedure, slug: 'api-test' }]) });
    const bySlug = await clientWith().procedures.resolve('api-test');
    expect(bySlug).toMatchObject({ id: 5 });
    const named = await clientWith().procedures.resolve('API TEST');
    expect(named).toBeNull();
    // A bare numeric string is an id, fetched directly.
    expect(spy.calls.length).toBeGreaterThanOrEqual(2);
    const direct = routed({ [`${PATH}/5`]: () => json({ procedure }) });
    await expect(clientWith().procedures.resolve('5')).resolves.toMatchObject({ id: 5 });
    expect(direct.calls[0]?.url).toBe(`https://hudu.example.com${PATH}/5`);
  });

  it('iterates list and listPages and bounds a scan that never ends', async () => {
    const spy = routed({ [PATH]: procedurePages([procedure]) });
    const items: unknown[] = [];
    for await (const record of clientWith().procedures.list({})) items.push(record);
    expect(items).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of clientWith().procedures.listPages({})) pages.push(page);
    expect(pages).toHaveLength(1);
    spy.setHandler((url) => procedurePages([{ ...procedure, id: 999 }])(url));
    // The client scan is capped: 4 pages, then RESOLUTION_TRUNCATED instead of null.
    const endless = stubFetch((raw) => {
      const url = new URL(raw);
      const size = Number(url.searchParams.get('page_size') ?? '25');
      return json({ procedures: Array.from({ length: size }, (_v, index) => ({ ...procedure, id: 1000 + index, name: 'x', slug: 'x' })) });
    });
    const err = await rejection(clientWith().procedures.resolve({ name: 'API TEST' }));
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(endless.calls).toHaveLength(4);
  });
});

describe('ProceduresResource — bounded candidate collection', () => {
  afterEach(() => clearFetch());

  it('stops at the first collected candidate when limit is 1', async () => {
    const spy = routed({ [PATH]: procedurePages([procedure, { ...procedure, id: 6, slug: 'other' }]) });
    const client = clientWith();
    await expect(client.procedures.resolve({ name: procedure.name }, { limit: 1 })).resolves.toMatchObject({ id: 5 });
    await expect(client.procedures.resolve({ slug: procedure.slug }, { limit: 1 })).resolves.toMatchObject({ id: 5 });
    expect(spy.calls).toHaveLength(2);
    // `numericIds` reads a numeric string and an object id; both reach the dry-run target.
    const dryString = await clientWith().procedures.delete('5', { dryRun: true });
    expect(dryString.target.ids).toEqual([5]);
    const dryObject = await clientWith().procedures.duplicate(5, { company_id: 2 }, { dryRun: true });
    expect(dryObject.target.ids).toEqual([5]);
  });
});
