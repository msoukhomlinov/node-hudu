/**
 * MagicDashResource tests — primitives plus the helper tier.
 *
 * `magic_dash` has no `GET /magic_dash/{id}` (an id is resolved by a bounded client
 * scan), the DELETE by title is a bulk form-urlencoded delete, and
 * `PUT /magic_dash/update_positions` is a multi-record fan-out. Both bulk shapes must
 * refuse to run without a bound and declare `impact.scope: "bulk"`.
 *
 * The `it(...)` titles are asserted verbatim by `capabilities:check` against the
 * `magic_dash` rows of capabilities.plan.json.
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

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: 'Microsoft 365',
    message: '5 seats left',
    shade: 'info',
    content_link: 'https://portal.office.com',
    content: '<b>5 seats left</b>',
    icon: 'fa-solid fa-envelope',
    image_url: 'https://cdn.example.com/i.png',
    company_id: 3,
    company_name: 'Acme',
    position: 1,
    ...overrides,
  };
}

/** Serve `items` through the paginated /magic_dash endpoint, 25 per page. */
function itemPages(items: unknown[]): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    return json(items.slice((page - 1) * size, page * size));
  };
}

/** Always-full pages with non-matching ids: the scan can never finish. */
function endlessItemPages(): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    return json(Array.from({ length: size }, (_v, index) => item({ id: page * 1000 + index, title: `t${page}-${index}` })));
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

describe('MagicDashResource — agent execution layer', () => {
  afterEach(() => clearFetch());

  it('calls the magic_dash.delete endpoint and normalises the result', async () => {
    const spy = routed({ '/api/v1/magic_dash': () => empty(204) });
    await expect(makeClient().magicDash.delete({ title: 'Microsoft 365', company_name: 'AcmeCorp' })).resolves.toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
    expect(spy.calls[0]?.url).toBe('https://hudu.example.com/api/v1/magic_dash');
    expect(String(spy.calls[0]?.init.body)).toContain('Microsoft+365');
    expect(String(spy.calls[0]?.init.body)).toContain('AcmeCorp');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    // The bulk dry-run probes the blast radius with ONE read; it must never DELETE.
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([item()]) : empty(204)));
    const result = await makeClient().magicDash.delete({ title: 'Microsoft 365', company_name: 'Acme' }, { dryRun: true });
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET']);
    expect(result).toMatchObject({
      operation: 'magic_dash.delete',
      request: { method: 'DELETE', path: '/magic_dash' },
      simulated: true,
      wouldApply: true,
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/magic_dash': () => empty(204) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.magicDash.delete({ title: 't', company_name: 'c' });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.effect).toBe('destructive');
    spy.setHandler(() => json({ message: 'no key' }, 401));
    const err = await rejection(client.magicDash.delete({ title: 't', company_name: 'c' }));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.correlationId).toMatch(UUID);
  });

  it('refuses to run unconfirmed and reports the impact bound', async () => {
    const refused = routed({});
    const client = makeClient();
    const err = await rejection(client.magicDash.delete({ title: '   ', company_name: 'Acme' }));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.category).toBe('policy');
    expect(refused.calls).toHaveLength(0);
    const missingCompany = await rejection(client.magicDash.delete({ title: 'Microsoft 365', company_name: '' }));
    expect(missingCompany.code).toBe('POLICY_DENIED');
    expect(refused.calls).toHaveLength(0);
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([item()]) : empty(204)));
    const described = await client.magicDash.delete(
      { title: 'Microsoft 365', company_name: 'Acme' },
      { dryRun: true },
    );
    expect(described.impact).toEqual({ affected: 1, scope: 'bulk', reversible: false, exact: false });
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET']);
  });

  it('dry-run reports the affected count and issues no request', async () => {
    // Title verbatim from the plan row; the mandated floor probe is a READ, so the assertion is
    // "exactly one GET and zero mutating requests" rather than "zero requests".
    const spy = stubFetch((_raw, init) => (init.method === 'GET' ? json([item()]) : empty(204)));
    const result = await makeClient().magicDash.delete(
      { title: 'Microsoft 365', company_name: 'Acme' },
      { dryRun: true },
    );
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET']);
    expect(result.impact.affected).toBe(1);
    expect(result.impact.scope).toBe('bulk');
    expect(result.warnings.join(' ')).toContain('Microsoft 365');
  });

  it('reports affected as a bounded FLOOR for the by-title bulk delete', async () => {
    const spy = stubFetch((_raw, init) =>
      (init.method === 'GET'
        ? json([item(), item({ id: 8 }), item({ id: 9, company_name: 'Other' })])
        : empty(204)));
    const result = await makeClient().magicDash.delete(
      { title: 'Microsoft 365', company_name: 'Acme' },
      { dryRun: true },
    );
    // Only the items matching BOTH bounds count; the rest of the server-side set is unknown.
    expect(result.impact.exact).toBe(false);
    expect(result.impact.affected).toBe(2);
    expect(result.impact.scope).toBe('bulk');
    expect(result.impact.reversible).toBe(false);
    expect(result.request.method).toBe('DELETE');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('GET');
    expect(spy.calls[0]?.url).toContain('page_size=100');
    expect(spy.calls[0]?.url).toContain('title=Microsoft+365');
    expect(result.warnings.join(' ')).toContain('FLOOR');
    expect(result.warnings.join(' ')).toContain('the server decides the final target set');
  });

  it('calls the magic_dash.deleteById endpoint and returns the documented shape', async () => {
    const spy = routed({ '/api/v1/magic_dash/7': () => empty(204) });
    await expect(makeClient().magicDash.deleteById(7)).resolves.toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
    expect(spy.calls[0]?.url).toBe('https://hudu.example.com/api/v1/magic_dash/7');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/magic_dash/7': () => empty(204) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.magicDash.deleteById(7);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('magic_dash.deleteById');
    spy.setHandler(() => json({ message: 'missing' }, 404));
    const err = await rejection(client.magicDash.deleteById(7));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().magicDash.deleteById(7, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'magic_dash.deleteById',
      request: { method: 'DELETE', path: '/magic_dash/7' },
      target: { resource: 'magic_dash', ids: [7] },
      simulated: true,
    });
  });

  it('refuses to run unconfirmed and reports the impact bound', async () => {
    const spy = routed({});
    const client = makeClient();
    // deleteById is bounded by ONE explicit id: a call without one has no target to bound.
    const err = await rejection(client.magicDash.deleteById(0));
    expect(err.code).toBe('CONFIG_ERROR');
    expect(spy.calls).toHaveLength(0);
    const described = await client.magicDash.deleteById(7, { dryRun: true });
    expect(described.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
    expect(described.target.ids).toEqual([7]);
  });

  it('dry-run reports the affected count and issues no request', async () => {
    const spy = routed({});
    const result = await makeClient().magicDash.deleteById(7, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.impact.affected).toBe(1);
    expect(result.impact.scope).toBe('single');
    expect(result.checks[0]).toMatchObject({ name: 'target-identifier', ok: true });
  });

  it('returns the unwrapped magic_dash list', async () => {
    const spy = routed({ '/api/v1/magic_dash': itemPages([item()]) });
    await expect(makeClient().magicDash.listAll({})).resolves.toEqual([item()]);
    expect(spy.calls[0]?.url).toContain('/api/v1/magic_dash');
  });

  it('sends page/page_size and stops on a short page', async () => {
    const items = Array.from({ length: 30 }, (_v, index) => item({ id: index + 1 }));
    const spy = routed({ '/api/v1/magic_dash': itemPages(items) });
    const res = await makeClient().magicDash.listAll({});
    expect(res).toHaveLength(30);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.url).toContain('page=1');
    expect(spy.calls[0]?.url).toContain('page_size=25');
    expect(spy.calls[1]?.url).toContain('page=2');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/magic_dash': itemPages([item()]) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.magicDash.listAll({});
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'nope' }, 404));
    const err = await rejection(client.magicDash.listAll({}));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the created magic_dash record', async () => {
    const spy = routed({ '/api/v1/magic_dash': () => json(item(), 201) });
    const res = await makeClient().magicDash.create({ title: 'Microsoft 365' });
    expect(res).toEqual(item());
    expect(spy.calls[0]?.init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().magicDash.create({ title: 'Microsoft 365' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({ operation: 'magic_dash.create', request: { method: 'POST', path: '/magic_dash' }, simulated: true });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/magic_dash': () => json(item(), 201) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.magicDash.create({ title: 'x' });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'invalid' }, 422));
    const err = await rejection(client.magicDash.create({ title: '' }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

  it('calls the magic_dash.updatePositions endpoint and normalises the result', async () => {
    const spy = routed({ '/api/v1/magic_dash/update_positions': () => json({ success: true }) });
    const res = await makeClient().magicDash.updatePositions({ company_id: 3, positions: [{ id: 7, position: 1 }, { id: 8, position: 2 }] });
    expect(res).toEqual({ success: true });
    expect(spy.calls[0]?.init.method).toBe('PUT');
    expect(spy.calls[0]?.init.body).toBe(JSON.stringify({ company_id: 3, positions: [{ id: 7, position: 1 }, { id: 8, position: 2 }] }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().magicDash.updatePositions(
      { company_id: 3, positions: [{ id: 7, position: 1 }] },
      { dryRun: true },
    );
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'magic_dash.updatePositions',
      request: { method: 'PUT', path: '/magic_dash/update_positions' },
      simulated: true,
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/magic_dash/update_positions': () => json({ success: true }) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.magicDash.updatePositions({ company_id: 3, positions: [{ id: 7, position: 1 }] });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ success: false, error: 'bad' }, 422));
    const err = await rejection(client.magicDash.updatePositions({ company_id: 3, positions: [{ id: 7, position: 1 }] }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

  it('refuses to run unconfirmed and reports the impact bound', async () => {
    const spy = routed({});
    const client = makeClient();
    const err = await rejection(client.magicDash.updatePositions({ company_id: 3, positions: [] }));
    expect(err.code).toBe('POLICY_DENIED');
    expect(spy.calls).toHaveLength(0);
    const described = await client.magicDash.updatePositions(
      { company_id: 3, positions: [{ id: 7, position: 1 }, { id: 8, position: 2 }] },
      { dryRun: true },
    );
    expect(described.impact).toEqual({ affected: 2, scope: 'bulk', reversible: true, exact: true });
    expect(described.target.ids).toEqual([7, 8]);
    expect(spy.calls).toHaveLength(0);
  });

  it('dry-run reports the affected count and issues no request', async () => {
    const spy = routed({});
    const result = await makeClient().magicDash.updatePositions(
      { company_id: 3, positions: [{ id: 7, position: 1 }, { id: 8, position: 2 }, { id: 9, position: 3 }] },
      { dryRun: true },
    );
    expect(spy.calls).toHaveLength(0);
    expect(result.impact.affected).toBe(3);
    expect(result.impact.scope).toBe('bulk');
    // The caller supplied the bound, so the count IS the affected set.
    expect(result.impact.exact).toBe(true);
    expect(result.checks[0]).toMatchObject({ name: 'explicit-targets', ok: true });
  });

  it('finds the item by exact title without a full scan', async () => {
    const spy = routed({ '/api/v1/magic_dash': itemPages([item(), item({ id: 8, title: 'Other' })]) });
    const res = await makeClient().magicDash.resolve({ title: 'Microsoft 365', company_id: 3 });
    expect(res).toMatchObject({ id: 7, title: 'Microsoft 365' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('title=Microsoft+365');
    expect(spy.calls[0]?.url).toContain('company_id=3');
    const detailed = await makeClient().magicDash.resolve('Microsoft 365', { resolutionDetails: true });
    expect(detailed).toMatchObject({ resolutionCost: 'server-filter', scanTruncated: false });
    expect(detailed.candidates).toEqual([{ id: 7, label: 'Microsoft 365' }]);
  });

  it('falls back to a bounded client scan', async () => {
    const spy = routed({ '/api/v1/magic_dash': itemPages([item({ id: 1 }), item({ id: 7 })]) });
    const res = await makeClient().magicDash.resolve({ id: 7 });
    expect(res).toMatchObject({ id: 7 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).not.toContain('/magic_dash/7');
  });

  it('throws NOT_FOUND when the complete scan has no match', async () => {
    routed({ '/api/v1/magic_dash': itemPages([item({ id: 1 })]) });
    const err = await rejection(makeClient().magicDash.resolve(999));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('throws RESOLUTION_TRUNCATED instead of null when the scan hits the cap', async () => {
    const spy = routed({ '/api/v1/magic_dash': endlessItemPages() });
    const err = await rejection(makeClient().magicDash.resolve(999));
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(spy.calls).toHaveLength(4);
  });

  it('returns MagicDashSummary', async () => {
    routed({ '/api/v1/magic_dash': itemPages([item()]) });
    const client = makeClient();
    const summary = await client.magicDash.resolve(7);
    expect(summary).toEqual({
      id: 7,
      title: 'Microsoft 365',
      message: '5 seats left',
      shade: 'info',
      icon: 'fa-solid fa-envelope',
      image_url: 'https://cdn.example.com/i.png',
      company_id: 3,
      company_name: 'Acme',
      position: 1,
    });
    expect(summary).not.toHaveProperty('content');
    expect(summary).not.toHaveProperty('content_link');
    const full = await client.magicDash.resolve(7, { expand: true });
    expect(full).toEqual(item());
  });

  it("returns the company's dashboard items", async () => {
    const spy = routed({ '/api/v1/magic_dash': itemPages([item(), item({ id: 8 })]) });
    const res = await makeClient().magicDash.findByCompany(3);
    expect(res).toHaveLength(2);
    expect(res[0]).not.toHaveProperty('content');
    expect(spy.calls[0]?.url).toContain('company_id=3');
  });

  it('returns an empty array for a company with no items', async () => {
    routed({ '/api/v1/magic_dash': itemPages([]) });
    await expect(makeClient().magicDash.findByCompany(99)).resolves.toEqual([]);
  });

  it('honours limit and never exceeds 100', async () => {
    const items = Array.from({ length: 60 }, (_v, index) => item({ id: index + 1 }));
    const spy = routed({ '/api/v1/magic_dash': itemPages(items) });
    const client = makeClient();
    const res = await client.magicDash.findByCompany(3, { limit: 30 });
    expect(res).toHaveLength(30);
    expect(spy.calls.length).toBeLessThanOrEqual(3);
    await expect(client.magicDash.findByCompany(3, { limit: 101 })).rejects.toThrow(HuduConfigError);
    await expect(client.magicDash.findByCompany(0)).rejects.toThrow(HuduConfigError);
  });
});

describe('MagicDashResource — resolution edge cases', () => {
  afterEach(() => clearFetch());

  it('accepts a numeric string id, narrows a scan by company and returns null when a title is absent', async () => {
    const spy = routed({ '/api/v1/magic_dash': itemPages([item()]) });
    const client = makeClient();
    await expect(client.magicDash.resolve('7')).resolves.toMatchObject({ id: 7 });
    await expect(client.magicDash.resolve({ id: 7, company_id: 3 })).resolves.toMatchObject({ id: 7 });
    await expect(client.magicDash.resolve({ title: 'No such title' })).resolves.toBeNull();
    // The second call narrows the id scan by company_id; the third is the title filter.
    expect(spy.calls[1]?.url).toContain('company_id=3');
    expect(spy.calls[2]?.url).toContain('title=No+such+title');
  });

  it('refuses identifier kinds and unbounded bulk calls', async () => {
    const spy = routed({ '/api/v1/magic_dash': itemPages([item()]) });
    const client = makeClient();
    await expect(client.magicDash.resolve('')).rejects.toThrow(HuduConfigError);
    await expect(client.magicDash.resolve({})).rejects.toThrow(HuduConfigError);
    await expect(client.magicDash.resolve(null as never)).rejects.toThrow(HuduConfigError);
    await expect(client.magicDash.findByCompany(0)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
    const denied = await rejection(
      client.magicDash.updatePositions({} as { company_id: number; positions: Array<{ id: number; position: number }> }),
    );
    expect(denied.code).toBe('POLICY_DENIED');
    expect(denied.resourceIds).toBeUndefined();
    expect(spy.calls).toHaveLength(0);
  });

  it('refuses expectedUpdatedAt on every path whose staleCheck is unavailable', async () => {
    const spy = routed({});
    const client = makeClient();
    const cases: Array<Promise<unknown>> = [
      client.magicDash.create({ title: 'x' }, { expectedUpdatedAt: '2024-05-01T00:00:00Z' }),
      client.magicDash.delete({ title: 'x', company_name: 'y' }, { expectedUpdatedAt: '2024-05-01T00:00:00Z' }),
      client.magicDash.deleteById(7, { expectedUpdatedAt: '2024-05-01T00:00:00Z' }),
      client.magicDash.updatePositions(
        { company_id: 3, positions: [{ id: 7, position: 1 }] },
        { expectedUpdatedAt: '2024-05-01T00:00:00Z' },
      ),
    ];
    for (const call of cases) {
      const err = await rejection(call);
      expect(err.code).toBe('CONFIG_ERROR');
      expect(err.message).toContain('update (PUT) only');
    }
    expect(spy.calls).toHaveLength(0);
  });

  it('iterates list and listPages and returns the details view', async () => {
    routed({ '/api/v1/magic_dash': itemPages([item()]) });
    const client = makeClient();
    const items: unknown[] = [];
    for await (const record of client.magicDash.list({})) items.push(record);
    expect(items).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of client.magicDash.listPages({})) pages.push(page);
    expect(pages).toHaveLength(1);
    const detailed = await client.magicDash.resolve(7, { resolutionDetails: true });
    expect(detailed).toMatchObject({ resolutionCost: 'client-scan', scanTruncated: false });
    expect(detailed.candidates).toEqual([{ id: 7, label: 'Microsoft 365' }]);
  });
});

describe('MagicDashResource — bounded candidate collection', () => {
  afterEach(() => clearFetch());

  it('stops at the first collected candidate when limit is 1', async () => {
    const spy = routed({ '/api/v1/magic_dash': itemPages([item(), item({ id: 8, title: 'Other' })]) });
    const client = makeClient();
    await expect(client.magicDash.resolve({ title: 'Microsoft 365' }, { limit: 1 })).resolves.toMatchObject({ id: 7 });
    await expect(client.magicDash.resolve({ id: 7 }, { limit: 1 })).resolves.toMatchObject({ id: 7 });
    expect(spy.calls).toHaveLength(2);
    const dry = await client.magicDash.deleteById('7' as never, { dryRun: true }).catch((err: Error) => err);
    expect(dry).toBeInstanceOf(HuduConfigError);
  });
});
