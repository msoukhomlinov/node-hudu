/**
 * ExpirationsResource tests — primitives plus the helper tier.
 *
 * The vendor exposes `GET /expirations` (paginated), `PUT /expirations/{id}` and
 * `DELETE /expirations/{id}` — there is NO `GET /expirations/{id}` and no id list filter,
 * so the id kind of `resolve` is answered by a bounded client scan rather than a
 * single-get that does not exist. The `it(...)` titles are asserted verbatim by
 * `capabilities:check` against the `expirations` rows of capabilities.plan.json.
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

function expiration(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    date: '2027-01-31',
    expirationable_type: 'Asset',
    expirationable_id: 77,
    account_id: 5,
    company_id: 3,
    asset_layout_field_id: null,
    sync_id: null,
    archived_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-05-01T00:00:00Z',
    expiration_type: 'domain',
    asset_field_id: null,
    ...overrides,
  };
}

/** Serve `items` through the paginated /expirations endpoint, 25 per page. */
function expirationPages(items: unknown[]): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    return json(items.slice((page - 1) * size, page * size));
  };
}

/** Always-full pages with non-matching ids: the scan can never finish. */
function endlessExpirationPages(): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    return json(Array.from({ length: size }, (_v, index) => expiration({ id: page * 1000 + index })));
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

describe('ExpirationsResource — agent execution layer', () => {
  afterEach(() => clearFetch());

  it('resolves void after a successful delete', async () => {
    const spy = routed({ '/api/v1/expirations/1': () => empty(204) });
    await expect(makeClient().expirations.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
    expect(spy.calls[0]?.url).toBe('https://hudu.example.com/api/v1/expirations/1');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().expirations.delete(1, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'expirations.delete',
      request: { method: 'DELETE', path: '/expirations/1' },
      simulated: true,
      impact: { scope: 'single', reversible: false },
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/expirations/1': () => empty(204) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.expirations.delete(1);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.effect).toBe('destructive');
    spy.setHandler(() => json({ message: 'missing' }, 404));
    const err = await rejection(client.expirations.delete(1));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

    it('returns the unwrapped expirations list', async () => {
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    await expect(makeClient().expirations.listAll({})).resolves.toEqual([expiration()]);
    expect(spy.calls[0]?.url).toContain('/api/v1/expirations');
  });

  it('sends page/page_size and stops on a short page', async () => {
    const items = Array.from({ length: 30 }, (_v, index) => expiration({ id: index + 1 }));
    const spy = routed({ '/api/v1/expirations': expirationPages(items) });
    const res = await makeClient().expirations.listAll({});
    expect(res).toHaveLength(30);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.url).toContain('page=1');
    expect(spy.calls[0]?.url).toContain('page_size=25');
    expect(spy.calls[1]?.url).toContain('page=2');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.expirations.listAll({});
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('expirations.list');
    spy.setHandler(() => json({ message: 'nope' }, 404));
    const err = await rejection(client.expirations.listAll({}));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the updated expirations record', async () => {
    const spy = routed({ '/api/v1/expirations/1': () => json(expiration({ date: '2028-02-01' })) });
    const res = await makeClient().expirations.update(1, { date: '2028-02-01' });
    expect(res).toEqual(expiration({ date: '2028-02-01' }));
    expect(spy.calls[0]?.init.method).toBe('PUT');
    expect(spy.calls[0]?.init.body).toBe(JSON.stringify({ expiration: { date: '2028-02-01' } }));
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().expirations.update(1, { date: '2028-02-01' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'expirations.update',
      request: { method: 'PUT', path: '/expirations/1' },
      target: { resource: 'expirations', ids: [1] },
      simulated: true,
    });
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `expirations` declares no singleKey, so the PUT body is passed through unchanged.
    const spy = routed({ '/api/v1/expirations/1': () => json({ id: 1, date: '2028-02-01' }) });
    const res = await makeClient().expirations.update(1, { date: '2028-02-01' });
    expect(res).toEqual({ id: 1, date: '2028-02-01' });
    expect(spy.calls[0]?.url).toBe('https://hudu.example.com/api/v1/expirations/1');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/expirations/1': () => json(expiration()) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.expirations.update(1, { date: '2028-02-01' });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'invalid' }, 422));
    const err = await rejection(client.expirations.update(1, { date: 'nope' }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const spy = routed({
      '/api/v1/expirations': expirationPages([expiration()]),
      '/api/v1/expirations/1': () => json(expiration({ date: '2028-02-01' })),
    });
    const err = await rejection(
      makeClient().expirations.update(1, { date: '2028-02-01' }, { expectedUpdatedAt: '1999-01-01T00:00:00Z' }),
    );
    expect(err.code).toBe('STALE_OBJECT');
    expect(err.resourceIds).toEqual([1]);
    expect(spy.calls.map((call) => call.init.method)).toEqual(['GET']);
    const ok = routed({
      '/api/v1/expirations': expirationPages([expiration()]),
      '/api/v1/expirations/1': () => json(expiration({ date: '2028-02-01' })),
    });
    await makeClient().expirations.update(1, { date: '2028-02-01' }, { expectedUpdatedAt: '2024-05-01T00:00:00Z' });
    expect(ok.calls.map((call) => call.init.method)).toEqual(['GET', 'PUT']);
  });

  it('fetches by id without a scan', async () => {
    // The design basis is "server-filter", but the vendor declares no GET /expirations/{id}
    // and no id list filter, so this is the honest implementation: an exact id compare
    // inside ONE bounded page of the list endpoint (never a fabricated single-get).
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    const res = await makeClient().expirations.resolve(1);
    expect(res).toMatchObject({ id: 1, expiration_type: 'domain' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('/api/v1/expirations?');
    expect(spy.calls[0]?.url).not.toContain('/expirations/1');
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    const err = await rejection(makeClient().expirations.resolve(999));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('returns the single exact match', async () => {
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    const res = await makeClient().expirations.resolve({ resource_type: 'Asset', resource_id: 77 });
    expect(res).toMatchObject({ id: 1, date: '2027-01-31' });
    expect(spy.calls[0]?.url).toContain('resource_type=Asset');
    expect(spy.calls[0]?.url).toContain('resource_id=77');
    const detailed = await makeClient().expirations.resolve(
      { resource_type: 'Asset', resource_id: 77 },
      { resolutionDetails: true },
    );
    expect(detailed).toMatchObject({ resolutionCost: 'server-filter', scanTruncated: false });
    expect(detailed.candidates).toEqual([{ id: 1, label: 'domain 2027-01-31' }]);
  });

  it('returns null after a complete scan', async () => {
    const spy = routed({ '/api/v1/expirations': expirationPages([]) });
    await expect(makeClient().expirations.resolve({ resource_type: 'Asset', resource_id: 77 })).resolves.toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids when a resource has several expirations', async () => {
    routed({
      '/api/v1/expirations': expirationPages([
        expiration({ id: 1, expiration_type: 'domain' }),
        expiration({ id: 2, expiration_type: 'ssl' }),
      ]),
    });
    const err = await rejection(makeClient().expirations.resolve({ resource_type: 'Asset', resource_id: 77 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 2]);
    expect(err.retryable).toBe(false);
  });

  it('returns ExpirationSummary', async () => {
    routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    const client = makeClient();
    const summary = await client.expirations.resolve(1);
    expect(summary).toEqual({
      id: 1,
      date: '2027-01-31',
      expiration_type: 'domain',
      company_id: 3,
      expirationable_type: 'Asset',
      expirationable_id: 77,
      asset_field_id: null,
      asset_layout_field_id: null,
      sync_id: null,
      updated_at: '2024-05-01T00:00:00Z',
    });
    expect(summary).not.toHaveProperty('account_id');
    expect(summary).not.toHaveProperty('archived_at');
    expect(summary).not.toHaveProperty('created_at');
    const full = await client.expirations.resolve(1, { expand: true });
    expect(full).toEqual(expiration());
  });

  it('returns the expirations of the resource', async () => {
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration(), expiration({ id: 2 })]) });
    const res = await makeClient().expirations.findByResource('Asset', 77);
    expect(res).toHaveLength(2);
    expect(res[0]).not.toHaveProperty('created_at');
    expect(spy.calls[0]?.url).toContain('resource_type=Asset');
    expect(spy.calls[0]?.url).toContain('resource_id=77');
  });

  it('returns an empty array when nothing expires', async () => {
    routed({ '/api/v1/expirations': expirationPages([]) });
    await expect(makeClient().expirations.findByResource('Asset', 999)).resolves.toEqual([]);
  });

  it('honours limit and never exceeds 100', async () => {
    const items = Array.from({ length: 60 }, (_v, index) => expiration({ id: index + 1 }));
    const spy = routed({ '/api/v1/expirations': expirationPages(items) });
    const client = makeClient();
    const res = await client.expirations.findByResource('Asset', 77, { limit: 30 });
    expect(res).toHaveLength(30);
    expect(spy.calls.length).toBeLessThanOrEqual(3);
    await expect(client.expirations.findByResource('Asset', 77, { limit: 101 })).rejects.toThrow(HuduConfigError);
    // The scan is bounded: an endless server still stops at the scan cap.
    const endless = routed({ '/api/v1/expirations': endlessExpirationPages() });
    const err = await rejection(client.expirations.resolve(999));
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(endless.calls).toHaveLength(4);
  });
});

describe('ExpirationsResource — resolution edge cases', () => {
  afterEach(() => clearFetch());

  it('accepts a numeric string id and refuses other identifier kinds', async () => {
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    const client = makeClient();
    await expect(client.expirations.resolve('1')).resolves.toMatchObject({ id: 1 });
    await expect(client.expirations.resolve('one')).rejects.toThrow(HuduConfigError);
    await expect(client.expirations.resolve({})).rejects.toThrow(HuduConfigError);
    await expect(client.expirations.resolve(null as never)).rejects.toThrow(HuduConfigError);
    await expect(client.expirations.resolve({ resource_type: 'Asset' })).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(1);
  });

  it('narrows a resource lookup with expiration_type and company_id', async () => {
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    const res = await makeClient().expirations.resolve({
      resource_type: 'Asset',
      resource_id: 77,
      expiration_type: 'domain',
      company_id: 3,
    });
    expect(res).toMatchObject({ id: 1 });
    expect(spy.calls[0]?.url).toContain('expiration_type=domain');
    expect(spy.calls[0]?.url).toContain('company_id=3');
    const byObjectId = routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    await expect(makeClient().expirations.resolve({ id: 1 })).resolves.toMatchObject({ id: 1 });
    expect(byObjectId.calls).toHaveLength(1);
  });

  it('refuses invalid findByResource arguments and iterates list/listPages', async () => {
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration()]) });
    const client = makeClient();
    await expect(client.expirations.findByResource('', 0)).rejects.toThrow(HuduConfigError);
    const items: unknown[] = [];
    for await (const record of client.expirations.list({})) items.push(record);
    expect(items).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of client.expirations.listPages({})) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(spy.calls).toHaveLength(2);
  });
});

describe('ExpirationsResource — bounded candidate collection', () => {
  afterEach(() => clearFetch());

  it('stops at the first collected candidate when limit is 1', async () => {
    const spy = routed({ '/api/v1/expirations': expirationPages([expiration(), expiration({ id: 2 })]) });
    const res = await makeClient().expirations.resolve({ resource_type: 'Asset', resource_id: 77 }, { limit: 1 });
    expect(res).toMatchObject({ id: 1 });
    expect(spy.calls).toHaveLength(1);
  });
});

describe('ExpirationsResource — expectedUpdatedAt is refused outside update', () => {
  afterEach(() => clearFetch());

  it('refuses the guard on delete and keeps it on update', async () => {
    const spy = routed({});
    const client = makeClient();
    const err = await rejection(client.expirations.delete(1, { expectedUpdatedAt: '2024-05-01T00:00:00Z' }));
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.message).toContain('update (PUT) only');
    expect(spy.calls).toHaveLength(0);
  });
});
