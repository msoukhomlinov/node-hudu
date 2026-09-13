/**
 * ProcedureTasksResource tests — primitives plus the helper tier.
 *
 * `GET /procedure_tasks` is NON-paginated: `page`/`page_size` must never reach it, and a
 * name lookup therefore reads the whole collection in one request, so a complete-scan
 * miss is definitive. The `it(...)` titles are asserted verbatim by `capabilities:check`
 * against the `procedure_tasks` rows of capabilities.plan.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import { stubFetch, json, empty, clearFetch, type FetchSpy } from '../helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeClient(extra: Record<string, unknown> = {}) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...extra });
}

function auditSpy() {
  const events: AuditEvent[] = [];
  return { events, onAudit: (event: AuditEvent) => { events.push(event); } };
}

async function rejection(promise: Promise<unknown>): Promise<HuduError> {
  try {
    await promise;
  } catch (err) {
    return err as HuduError;
  }
  throw new Error('expected the call to reject');
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
    completion_notes: 'internal notes',
    due_date: '2024-06-01',
    formatted_due_date: 'Jun 1, 2024',
    user_id: 2,
    user_name: 'Tech Two',
    assigned_users: [2, 3],
    first_assigned_user_id: 2,
    first_assigned_user_name: 'Tech Two',
    first_assigned_user_initials: 'TT',
    procedure_id: 42,
    optional: false,
    parent_task_id: null,
    subtask_ids: [6, 7],
    subtask_count: 2,
    has_subtasks: true,
    url: 'https://hudu.example.com/tasks/5',
    created_at: '2024-04-01T00:00:00Z',
    updated_at: '2024-05-01T00:00:00Z',
    ...overrides,
  };
}

function routed(routes: Record<string, (url: URL) => Response>): FetchSpy {
  return stubFetch((raw) => {
    const url = new URL(raw);
    const handler = routes[url.pathname];
    if (handler === undefined) throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    return handler(url);
  });
}

const PATH = '/api/v1/procedure_tasks';
const BASE = `https://hudu.example.com${PATH}`;

describe('ProcedureTasksResource — agent execution layer', () => {
  afterEach(() => clearFetch());

  it('resolves void after a successful delete', async () => {
    const spy = routed({ [`${PATH}/5`]: () => empty(204) });
    await expect(makeClient().procedureTasks.delete(5)).resolves.toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
    expect(spy.calls[0]?.url).toBe(`${BASE}/5`);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().procedureTasks.delete(5, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'procedure_tasks.delete',
      request: { method: 'DELETE', path: '/procedure_tasks/5' },
      simulated: true,
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/5`]: () => empty(204) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.procedureTasks.delete(5);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.effect).toBe('destructive');
    spy.setHandler(() => json({ message: 'missing' }, 404));
    const err = await rejection(client.procedureTasks.delete(5));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

    it('returns the unwrapped procedure_tasks list', async () => {
    const spy = routed({ [PATH]: () => json({ procedure_tasks: [task()] }) });
    await expect(makeClient().procedureTasks.listAll({ procedure_id: 42 })).resolves.toEqual([task()]);
    expect(spy.calls[0]?.url).toContain('procedure_id=42');
  });

  it('never sends page/page_size to the non-paginated endpoint', async () => {
    const spy = routed({ [PATH]: () => json({ procedure_tasks: [task()] }) });
    await makeClient().procedureTasks.listAll({ procedure_id: 42, page: 3, page_size: 10 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('procedure_id=42');
    expect(spy.calls[0]?.url).not.toContain('page=');
    expect(spy.calls[0]?.url).not.toContain('page_size=');
    const items: unknown[] = [];
    for await (const record of makeClient().procedureTasks.list({ procedure_id: 42 })) items.push(record);
    expect(items).toEqual([task()]);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [PATH]: () => json({ procedure_tasks: [task()] }) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.procedureTasks.listAll({ procedure_id: 42 });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('procedure_tasks.list');
    spy.setHandler(() => json({ message: 'nope' }, 401));
    const err = await rejection(client.procedureTasks.listAll({ procedure_id: 42 }));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the unwrapped procedure_tasks record', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure_task: task() }) });
    await expect(makeClient().procedureTasks.get(5)).resolves.toEqual(task());
    expect(spy.calls[0]?.url).toBe(`${BASE}/5`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    routed({ [`${PATH}/5`]: () => json({ message: 'missing' }, 404) });
    const err = await rejection(makeClient().procedureTasks.get(5));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure_task: task() }) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.procedureTasks.get(5);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('procedure_tasks.get');
    spy.setHandler(() => json({ message: 'missing' }, 404));
    const err = await rejection(client.procedureTasks.get(5));
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the created procedure_tasks record', async () => {
    const spy = routed({ [PATH]: () => json({ procedure_task: task() }, 201) });
    const res = await makeClient().procedureTasks.create({ name: 'Check backups', procedure_id: 42 });
    expect(res).toEqual(task());
    expect(spy.calls[0]?.init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().procedureTasks.create({ name: 'Check backups' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({ operation: 'procedure_tasks.create', request: { method: 'POST', path: '/procedure_tasks' }, simulated: true });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [PATH]: () => json({ procedure_task: task() }, 201) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.procedureTasks.create({ name: 'x' });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'invalid' }, 422));
    const err = await rejection(client.procedureTasks.create({ name: '' }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

    it('returns the updated procedure_tasks record', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure_task: task({ completed: true }) }) });
    const res = await makeClient().procedureTasks.update(5, { completed: true });
    expect(res).toEqual(task({ completed: true }));
    expect(spy.calls[0]?.init.method).toBe('PUT');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().procedureTasks.update(5, { completed: true }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'procedure_tasks.update',
      request: { method: 'PUT', path: '/procedure_tasks/5' },
      simulated: true,
    });
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `singleKey: 'procedure_task'` — the PUT response is unwrapped by that key.
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure_task: task() }) });
    const res = await makeClient().procedureTasks.update(5, { completed: true });
    expect(res).toEqual(task());
    expect(spy.calls[0]?.url).toBe(`${BASE}/5`);
    const envelope = routed({ [`${PATH}/5`]: () => json({ procedure_task: task(), extra: 1 }) });
    expect(await makeClient().procedureTasks.update(5, { completed: true })).toEqual(task());
    expect(envelope.calls).toHaveLength(1);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure_task: task() }) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.procedureTasks.update(5, { completed: true });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'invalid' }, 422));
    const err = await rejection(client.procedureTasks.update(5, { completed: 'yes' }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

  it('refuses expectedUpdatedAt on update with CONFIG_ERROR because no record carries updated_at', async () => {
    // Live-verified on Hudu 2.45.1 (2026-09-12): a created procedure task and its GET response
    // carry NO created_at/updated_at, so this row's staleCheck is "unavailable", STALE_OBJECT is
    // unreachable, and the guard is refused by name before any request.
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure_task: task() }) });
    const err = await rejection(
      makeClient().procedureTasks.update(5, { completed: true }, { expectedUpdatedAt: '2024-05-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(spy.calls).toHaveLength(0);
  });

  it('fetches by id without a scan', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure_task: task() }) });
    const res = await makeClient().procedureTasks.resolve(5);
    expect(res).toMatchObject({ id: 5, name: 'Check backups' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toBe(`${BASE}/5`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    routed({ [`${PATH}/5`]: () => json({ message: 'missing' }, 404) });
    const err = await rejection(makeClient().procedureTasks.resolve(5));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('returns the single exact match', async () => {
    const spy = routed({ [PATH]: () => json({ procedure_tasks: [task(), task({ id: 6, name: 'Other' })] }) });
    const res = await makeClient().procedureTasks.resolve({ name: 'Check backups', procedure_id: 42 });
    expect(res).toMatchObject({ id: 5, name: 'Check backups' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('name=Check+backups');
    expect(spy.calls[0]?.url).toContain('procedure_id=42');
    // Non-paginated: the one request carries no page/page_size.
    expect(spy.calls[0]?.url).not.toContain('page=');
  });

  it('returns null after a complete scan', async () => {
    const spy = routed({ [PATH]: () => json({ procedure_tasks: [] }) });
    await expect(makeClient().procedureTasks.resolve('No such task')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('returns ProcedureTaskSummary', async () => {
    routed({ [`${PATH}/5`]: () => json({ procedure_task: task() }) });
    const client = makeClient();
    const summary = await client.procedureTasks.resolve(5);
    expect(summary).toEqual({
      id: 5,
      name: 'Check backups',
      position: 2,
      priority: 'normal',
      completed: false,
      completed_date: '',
      due_date: '2024-06-01',
      procedure_id: 42,
      optional: false,
      parent_task_id: null,
      has_subtasks: true,
      subtask_count: 2,
      first_assigned_user_name: 'Tech Two',
      url: 'https://hudu.example.com/tasks/5',
      updated_at: '2024-05-01T00:00:00Z',
    });
    for (const dropped of ['description', 'completion_notes', 'formatted_due_date', 'user_id', 'user_name', 'assigned_users', 'first_assigned_user_id', 'first_assigned_user_initials', 'subtask_ids', 'created_at']) {
      expect(summary, dropped).not.toHaveProperty(dropped);
    }
    expect(await client.procedureTasks.resolve(5, { expand: true })).toEqual(task());
    await expect(client.procedureTasks.resolve(5, { limit: 101 })).rejects.toThrow(HuduConfigError);
  });
});

describe('ProcedureTasksResource — resolution edge cases', () => {
  afterEach(() => clearFetch());

  it('rejects identifier kinds the vendor cannot filter on', async () => {
    const spy = routed({});
    const client = makeClient();
    await expect(client.procedureTasks.resolve('')).rejects.toThrow(HuduConfigError);
    await expect(client.procedureTasks.resolve({ x: 1 })).rejects.toThrow(HuduConfigError);
    await expect(client.procedureTasks.resolve({ id: 0 })).rejects.toThrow(HuduConfigError);
    await expect(client.procedureTasks.resolve({ name: 'x' }, { limit: 101 })).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('resolves a numeric string, an object id, a company-scoped name and the details view', async () => {
    const spy = routed({ [`${PATH}/5`]: () => json({ procedure_task: task() }) });
    await expect(makeClient().procedureTasks.resolve('5')).resolves.toMatchObject({ id: 5 });
    await expect(makeClient().procedureTasks.resolve({ id: 5 })).resolves.toMatchObject({ id: 5 });
    expect(spy.calls).toHaveLength(2);
    const detailed = await makeClient().procedureTasks.resolve({ id: 5 }, { resolutionDetails: true });
    expect(detailed).toMatchObject({ resolutionCost: 'direct', scanned: 1, scanTruncated: false });
    expect(detailed.candidates).toEqual([{ id: 5, label: 'Check backups' }]);
    const listed = routed({ [PATH]: () => json({ procedure_tasks: [task()] }) });
    await expect(makeClient().procedureTasks.resolve({ name: 'Check backups', company_id: 3 })).resolves.toMatchObject({ id: 5 });
    expect(listed.calls[0]?.url).toContain('company_id=3');
  });

  it('iterates list and listPages (the non-paginated endpoint serves one page)', async () => {
    routed({ [PATH]: () => json({ procedure_tasks: [task()] }) });
    const items: unknown[] = [];
    for await (const record of makeClient().procedureTasks.list({ procedure_id: 42 })) items.push(record);
    expect(items).toEqual([task()]);
    const pages: unknown[] = [];
    for await (const page of makeClient().procedureTasks.listPages({ procedure_id: 42 })) pages.push(page);
    expect(pages).toHaveLength(1);
  });
});

describe('ProcedureTasksResource — bounded candidate collection', () => {
  afterEach(() => clearFetch());

  it('stops at the first collected candidate when limit is 1', async () => {
    const spy = routed({ [PATH]: () => json({ procedure_tasks: [task(), task({ id: 6, name: 'Other' })] }) });
    await expect(makeClient().procedureTasks.resolve({ name: 'Check backups' }, { limit: 1 })).resolves.toMatchObject({ id: 5 });
    expect(spy.calls).toHaveLength(1);
    const dry = await makeClient().procedureTasks.delete('5', { dryRun: true });
    expect(dry.target.ids).toEqual([5]);
  });
});

describe('ProcedureTasksResource — expectedUpdatedAt is refused outside update', () => {
  afterEach(() => clearFetch());

  it('refuses the guard on create and delete', async () => {
    const spy = routed({});
    const client = makeClient();
    const guard = { expectedUpdatedAt: '2024-05-01T00:00:00Z' };
    for (const call of [client.procedureTasks.create({ name: 'x' }, guard), client.procedureTasks.delete(5, guard)]) {
      const err = await rejection(call);
      expect(err.code).toBe('CONFIG_ERROR');
      expect(err.message).toContain('update (PUT) only');
    }
    expect(spy.calls).toHaveLength(0);
  });
});

describe('ProcedureTasksResource — executed audit impact equals the dry-run impact', () => {
  afterEach(() => clearFetch());

  it('reports the SAME impact for create, update and delete', async () => {
    const audit = auditSpy();
    const spy = routed({
      [PATH]: () => json({ procedure_task: task() }, 201),
      [`${PATH}/5`]: () => json({ procedure_task: task() }),
    });
    spy.setHandler((raw, init) => {
      const url = new URL(raw);
      if (url.pathname === PATH && init.method === 'POST') return json({ procedure_task: task() }, 201);
      if (init.method === 'PUT') return json({ procedure_task: task() });
      if (init.method === 'DELETE') return empty(204);
      return json({ procedure_task: task() });
    });
    const client = makeClient({ onAudit: audit.onAudit });
    const describedCreate = await client.procedureTasks.create({ name: 'x' }, { dryRun: true });
    await client.procedureTasks.create({ name: 'x' });
    const describedUpdate = await client.procedureTasks.update(5, { completed: true }, { dryRun: true });
    await client.procedureTasks.update(5, { completed: true });
    const describedDelete = await client.procedureTasks.delete(5, { dryRun: true });
    await client.procedureTasks.delete(5);
    const executed = audit.events.filter((event) => !event.dryRun && event.effect !== 'read');
    expect(executed.map((event) => event.impact)).toEqual([
      { affected: 1, scope: 'single', reversible: true },
      { affected: 1, scope: 'single', reversible: true },
      { affected: 1, scope: 'single', reversible: false },
    ]);
    expect(executed[0]?.impact).toEqual(describedCreate.impact);
    expect(executed[1]?.impact).toEqual(describedUpdate.impact);
    expect(executed[2]?.impact).toEqual(describedDelete.impact);
  });
});
