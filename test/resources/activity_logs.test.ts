/**
 * ActivityLogsResource tests — primitives plus the helper tier.
 *
 * Hudu exposes no `GET /activity_logs/{id}`, so `resolve` is a bounded client scan, and
 * the DELETE is a bulk delete from a datetime on that the SDK refuses to run without a
 * bound. The `it(...)` titles are asserted verbatim by `capabilities:check` against the
 * `activity_logs` rows of capabilities.plan.json.
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

function log(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    user_id: 2,
    user_email: 'tech@acme.example',
    resource_id: 77,
    resource_type: 'Asset',
    action_message: 'updated an asset',
    created_at: '2024-05-01T10:00:00Z',
    updated_at: '2024-05-01T10:00:01Z',
    ...overrides,
  };
}

/** Serve `items` through the paginated /activity_logs endpoint, 25 per page. */
function logPages(items: unknown[]): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    return json(items.slice((page - 1) * size, page * size));
  };
}

/** Always-full pages with non-matching ids: the scan can never finish. */
function endlessLogPages(): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    return json(Array.from({ length: size }, (_v, index) => log({ id: page * 1000 + index })));
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

describe('ActivityLogsResource — agent execution layer', () => {
  afterEach(() => clearFetch());

  it('calls the activity_logs.deleteAll endpoint and normalises the result', async () => {
    // The live path takes the same bounded floor pre-read as the dry-run (so the audit impact
    // matches), then the DELETE: exactly ONE GET and ONE DELETE.
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([log()]) : empty(204)));
    await expect(
      makeClient().activityLogs.deleteAll({ datetime: '2024-01-01T00:00:00Z', delete_unassigned_logs: true }),
    ).resolves.toBeUndefined();
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET', 'DELETE']);
    const deletion = spy.calls[1];
    expect(deletion?.url).toContain('datetime=2024-01-01T00%3A00%3A00Z');
    expect(deletion?.url).toContain('delete_unassigned_logs=true');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    // The bulk dry-run probes the blast radius with ONE read; it must never DELETE.
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([log(), log({ id: 10 })]) : empty(204)));
    const result = await makeClient().activityLogs.deleteAll(
      { datetime: '2024-01-01T00:00:00Z' },
      { dryRun: true },
    );
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET']);
    expect(result).toMatchObject({
      operation: 'activity_logs.deleteAll',
      request: { method: 'DELETE', path: '/activity_logs' },
      simulated: true,
      wouldApply: true,
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([log()]) : empty(204)));
    const client = makeClient({ onAudit: audit.onAudit });
    await client.activityLogs.deleteAll({ datetime: '2024-01-01T00:00:00Z' });
    const deletion = audit.events.find((event) => event.effect === 'destructive');
    expect(deletion?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'no key' }, 401));
    const err = await rejection(client.activityLogs.deleteAll({ datetime: '2024-01-01T00:00:00Z' }));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.correlationId).toMatch(UUID);
  });

  it('refuses to run unconfirmed and reports the impact bound', async () => {
    const refused = routed({});
    const client = makeClient();
    // An empty datetime would delete the ENTIRE activity log: no bound, no run, no probe.
    const err = await rejection(client.activityLogs.deleteAll({ datetime: '   ' }));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.category).toBe('policy');
    expect(err.retryable).toBe(false);
    expect(refused.calls).toHaveLength(0);
    // With a bound, the dry-run declares the impact scope the caller is accepting.
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([log(), log({ id: 10 })]) : empty(204)));
    const described = await client.activityLogs.deleteAll(
      { datetime: '2024-01-01T00:00:00Z', delete_unassigned_logs: true },
      { dryRun: true },
    );
    expect(described.impact).toEqual({ affected: 2, scope: 'bulk', reversible: false, exact: false });
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET']);
  });

  it('dry-run reports the affected count and issues no request', async () => {
    // Title verbatim from the plan row; the mandated floor probe is a READ, so the assertion is
    // "exactly one GET and zero mutating requests" rather than "zero requests".
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([log()]) : empty(204)));
    const result = await makeClient().activityLogs.deleteAll(
      { datetime: '2024-01-01T00:00:00Z' },
      { dryRun: true },
    );
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET']);
    expect(result.impact.affected).toBe(1);
    expect(result.impact.scope).toBe('bulk');
    expect(result.checks[0]).toMatchObject({ name: 'bulk-bound', ok: true });
    expect(result.warnings.join(' ')).toContain('2024-01-01T00:00:00Z');
  });

  it('reports affected as a bounded FLOOR for a server-computed bulk delete', async () => {
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([log(), log({ id: 10 }), log({ id: 11 })]) : empty(204)));
    const result = await makeClient().activityLogs.deleteAll(
      { datetime: '2024-01-01T00:00:00Z' },
      { dryRun: true },
    );
    // exact: false = "affected is a LOWER BOUND, the server computes the real set".
    expect(result.impact.exact).toBe(false);
    expect(result.impact.affected).toBe(3);
    expect(result.impact.scope).toBe('bulk');
    expect(result.impact.reversible).toBe(false);
    expect(result.request.method).toBe('DELETE');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('GET');
    expect(spy.calls[0]?.url).toContain('page_size=100');
    expect(spy.calls[0]?.url).toContain('start_date=2024-01-01T00%3A00%3A00Z');
    expect(result.warnings.join(' ')).toContain('FLOOR');
    expect(result.warnings.join(' ')).toContain('the server decides the final target set');
  });

  it('reports the SAME impact in the dry-run and in the executed audit event', async () => {
    const audit = auditSpy();
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([log(), log({ id: 10 })]) : empty(204)));
    const client = makeClient({ onAudit: audit.onAudit });
    const params = { datetime: '2024-01-01T00:00:00Z' };
    const described = await client.activityLogs.deleteAll(params, { dryRun: true });
    await client.activityLogs.deleteAll(params);
    const executed = audit.events.find((event) => event.effect === 'destructive');
    expect(executed?.dryRun).toBe(false);
    expect(executed?.impact).toEqual(described.impact);
    expect(executed?.impact).toEqual({ affected: 2, scope: 'bulk', reversible: false, exact: false });
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET', 'GET', 'DELETE']);
  });

  it('refuses expectedUpdatedAt on the bulk delete (staleCheck is unavailable)', async () => {
    const spy = routed({});
    const err = await rejection(
      makeClient().activityLogs.deleteAll({ datetime: '2024-01-01T00:00:00Z' }, { expectedUpdatedAt: '2024-05-01T00:00:00Z' }),
    );
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.message).toContain('update (PUT) only');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns the unwrapped activity_logs list', async () => {
    const spy = routed({ '/api/v1/activity_logs': logPages([log()]) });
    await expect(makeClient().activityLogs.listAll({})).resolves.toEqual([log()]);
    expect(spy.calls[0]?.url).toContain('/api/v1/activity_logs');
  });

  it('sends page/page_size and stops on a short page', async () => {
    const items = Array.from({ length: 30 }, (_v, index) => log({ id: index + 1 }));
    const spy = routed({ '/api/v1/activity_logs': logPages(items) });
    const res = await makeClient().activityLogs.listAll({});
    expect(res).toHaveLength(30);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.url).toContain('page=1');
    expect(spy.calls[0]?.url).toContain('page_size=25');
    expect(spy.calls[1]?.url).toContain('page=2');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/activity_logs': logPages([log()]) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.activityLogs.listAll({});
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('activity_logs.list');
    spy.setHandler(() => json({ message: 'nope' }, 404));
    const err = await rejection(client.activityLogs.listAll({}));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

  it('finds the entry by a bounded client scan', async () => {
    const items = [log({ id: 1 }), log({ id: 2 }), log({ id: 9 })];
    const spy = routed({ '/api/v1/activity_logs': logPages(items) });
    const res = await makeClient().activityLogs.resolve({ id: 9, resource_type: 'Asset', resource_id: 77 });
    expect(res).toEqual({
      id: 9,
      user_id: 2,
      user_email: 'tech@acme.example',
      resource_id: 77,
      resource_type: 'Asset',
      action_message: 'updated an asset',
      created_at: '2024-05-01T10:00:00Z',
    });
    expect(spy.calls).toHaveLength(1);
    // There is no GET /activity_logs/{id}; the id is matched inside one bounded scan.
    expect(spy.calls[0]?.url).not.toContain('/activity_logs/9');
    expect(spy.calls[0]?.url).toContain('resource_id=77');
  });

  it('throws NOT_FOUND when the complete scan has no match', async () => {
    routed({ '/api/v1/activity_logs': logPages([log({ id: 1 })]) });
    const err = await rejection(makeClient().activityLogs.resolve(9));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('throws RESOLUTION_TRUNCATED instead of null when the scan hits the cap', async () => {
    const spy = routed({ '/api/v1/activity_logs': endlessLogPages() });
    const err = await rejection(makeClient().activityLogs.resolve(9));
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.category).toBe('resolution');
    expect(err.resourceIds).toBeUndefined();
    expect(spy.calls).toHaveLength(4);
    // allowClientScan: false refuses the fallback scan instead of guessing.
    const refused = await rejection(makeClient().activityLogs.resolve(9, { allowClientScan: false }));
    expect(refused.code).toBe('RESOLUTION_TRUNCATED');
  });

  it('returns ActivityLogSummary', async () => {
    routed({ '/api/v1/activity_logs': logPages([log()]) });
    const client = makeClient();
    const summary = await client.activityLogs.resolve(9);
    expect(summary).not.toHaveProperty('updated_at');
    const full = await client.activityLogs.resolve(9, { expand: true });
    expect(full).toEqual(log());
    const detailed = await client.activityLogs.resolve(9, { resolutionDetails: true });
    expect(detailed).toMatchObject({ resolutionCost: 'client-scan', scanned: 1, scanTruncated: false });
    expect(detailed.value).not.toHaveProperty('updated_at');
  });

  it('returns the entries for the resource', async () => {
    const spy = routed({ '/api/v1/activity_logs': logPages([log(), log({ id: 10 })]) });
    const res = await makeClient().activityLogs.findByResource('Asset', 77);
    expect(res).toHaveLength(2);
    expect(res[0]).not.toHaveProperty('updated_at');
    expect(spy.calls[0]?.url).toContain('resource_type=Asset');
    expect(spy.calls[0]?.url).toContain('resource_id=77');
  });

  it('returns an empty array for an untouched resource', async () => {
    routed({ '/api/v1/activity_logs': logPages([]) });
    await expect(makeClient().activityLogs.findByResource('Asset', 999)).resolves.toEqual([]);
  });

  it('respects start_date when given', async () => {
    const spy = routed({ '/api/v1/activity_logs': logPages([log()]) });
    const res = await makeClient().activityLogs.findByResource('Asset', 77, { startDate: '2024-05-01T00:00:00Z' });
    expect(res).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('start_date=2024-05-01T00%3A00%3A00Z');
    // The full records are available with expand.
    const full = await makeClient().activityLogs.findByResource('Asset', 77, { expand: true });
    expect(full[0]).toEqual(log());
  });

  it('honours limit and never exceeds 100', async () => {
    const items = Array.from({ length: 60 }, (_v, index) => log({ id: index + 1 }));
    const spy = routed({ '/api/v1/activity_logs': logPages(items) });
    const client = makeClient();
    const res = await client.activityLogs.findByResource('Asset', 77, { limit: 30 });
    expect(res).toHaveLength(30);
    expect(spy.calls.length).toBeLessThanOrEqual(3);
    await expect(client.activityLogs.findByResource('Asset', 77, { limit: 101 })).rejects.toThrow(HuduConfigError);
    await expect(client.activityLogs.findByResource('Asset', 77, { limit: 1.5 })).rejects.toThrow(HuduConfigError);
    await expect(client.activityLogs.findByResource('', 77)).rejects.toThrow(HuduConfigError);
  });
});

describe('ActivityLogsResource — resolution edge cases', () => {
  afterEach(() => clearFetch());

  it('accepts a numeric string id and refuses other identifier kinds', async () => {
    const spy = routed({ '/api/v1/activity_logs': logPages([log()]) });
    const client = makeClient();
    await expect(client.activityLogs.resolve('9')).resolves.toMatchObject({ id: 9 });
    await expect(client.activityLogs.resolve('nine')).rejects.toThrow(HuduConfigError);
    await expect(client.activityLogs.resolve({ resource_type: 'Asset' })).rejects.toThrow(HuduConfigError);
    await expect(client.activityLogs.resolve({ id: 0 })).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(1);
    const detailed = await client.activityLogs.resolve({ id: 9, resource_type: 'Asset', resource_id: 77 }, { resolutionDetails: true });
    expect(detailed.candidates).toEqual([{ id: 9, label: '9' }]);
  });

  it('iterates list and listPages', async () => {
    routed({ '/api/v1/activity_logs': logPages([log()]) });
    const items: unknown[] = [];
    for await (const record of makeClient().activityLogs.list({})) items.push(record);
    expect(items).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of makeClient().activityLogs.listPages({})) pages.push(page);
    expect(pages).toHaveLength(1);
  });
});

describe('ActivityLogsResource — bounded candidate collection', () => {
  afterEach(() => clearFetch());

  it('stops at the first collected candidate and refuses invalid resource filters', async () => {
    const spy = routed({ '/api/v1/activity_logs': logPages([log(), log({ id: 10 })]) });
    const client = makeClient();
    await expect(client.activityLogs.resolve({ id: 9 }, { limit: 1 })).resolves.toMatchObject({ id: 9 });
    await expect(client.activityLogs.findByResource('Asset', 0)).rejects.toThrow(HuduConfigError);
    await expect(client.activityLogs.findByResource('Asset', 1.5)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(1);
  });
});
