/**
 * MatchersResource tests — primitives plus the helper tier.
 *
 * `GET /matchers` requires `integration_id` and there is no `GET /matchers/{id}`, so the
 * helper tests prove each accepted kind is answered inside one integration (sync_id and
 * identifier through the vendor filters, an id by a bounded client scan).
 *
 * The `it(...)` titles are asserted verbatim by `capabilities:check` against the
 * `matchers` rows of capabilities.plan.json.
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

function matcher(overrides: Record<string, unknown> = {}) {
  return {
    id: 55,
    integrator_id: 4,
    integrator_name: 'autotask',
    sync_id: 29683607,
    identifier: 'green-mile-24',
    name: 'Green Mile 24',
    potential_company_id: null,
    company_id: 3,
    company_name: 'Acme',
    ...overrides,
  };
}

/** Serve `items` through the paginated /matchers endpoint, 25 per page. */
function matcherPages(items: unknown[]): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    return json({ matchers: items.slice((page - 1) * size, page * size) });
  };
}

/** Always-full pages with non-matching ids: the scan can never finish. */
function endlessMatcherPages(): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    const items = Array.from({ length: size }, (_v, index) => matcher({ id: page * 1000 + index }));
    return json({ matchers: items });
  };
}

/** Route by pathname so a test can serve reads and writes from one stub. */
function routed(routes: Record<string, (url: URL) => Response>): FetchSpy {
  return stubFetch((raw) => {
    const url = new URL(raw);
    const handler = routes[url.pathname];
    if (handler === undefined) throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    return handler(url);
  });
}

describe('MatchersResource — agent execution layer', () => {
  afterEach(() => clearFetch());

  it('resolves void after a successful delete', async () => {
    const spy = routed({ '/api/v1/matchers/55': () => empty(204) });
    await expect(makeClient().matchers.delete(55)).resolves.toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
    expect(spy.calls[0]?.url).toBe('https://hudu.example.com/api/v1/matchers/55');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().matchers.delete(55, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'matchers.delete',
      request: { method: 'DELETE', path: '/matchers/55' },
      simulated: true,
      wouldApply: true,
    });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/matchers/55': () => empty(204) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.matchers.delete(55);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('matchers.delete');
    spy.setHandler((raw) => {
      const url = new URL(raw);
      return url.pathname === '/api/v1/matchers/55' ? json({ message: 'missing' }, 404) : json({});
    });
    const err = await rejection(client.matchers.delete(55));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the unwrapped matchers list', async () => {
    const spy = routed({ '/api/v1/matchers': matcherPages([matcher()]) });
    const res = await makeClient().matchers.listAll({ integration_id: 4 });
    expect(res).toEqual([matcher()]);
    expect(spy.calls[0]?.url).toContain('/api/v1/matchers');
    expect(spy.calls[0]?.url).toContain('integration_id=4');
  });

  it('sends page/page_size and stops on a short page', async () => {
    const items = Array.from({ length: 30 }, (_v, index) => matcher({ id: index + 1 }));
    const spy = routed({ '/api/v1/matchers': matcherPages(items) });
    const res = await makeClient().matchers.listAll({ integration_id: 4 });
    expect(res).toHaveLength(30);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.url).toContain('page=1');
    expect(spy.calls[0]?.url).toContain('page_size=25');
    expect(spy.calls[1]?.url).toContain('page=2');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/matchers': matcherPages([matcher()]) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.matchers.listAll({ integration_id: 4 });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'bad integration' }, 400));
    const err = await rejection(client.matchers.listAll({ integration_id: 4 }));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the updated matchers record', async () => {
    const spy = routed({ '/api/v1/matchers/55': () => json(matcher({ name: 'Renamed' })) });
    const res = await makeClient().matchers.update(55, { name: 'Renamed' });
    expect(res).toEqual(matcher({ name: 'Renamed' }));
    expect(spy.calls[0]?.init.method).toBe('PUT');
    expect(spy.calls[0]?.init.body).toBe(JSON.stringify({ name: 'Renamed' }));
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = routed({});
    const result = await makeClient().matchers.update(55, { name: 'Renamed' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result).toMatchObject({
      operation: 'matchers.update',
      request: { method: 'PUT', path: '/matchers/55' },
      target: { resource: 'matchers', ids: [55] },
      simulated: true,
    });
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `matchers` declares no singleKey (the vendor returns a bare matcher record), so the
    // PUT response is passed through unchanged rather than re-wrapped or emptied.
    const spy = routed({ '/api/v1/matchers/55': () => json({ id: 55, name: 'Plain' }) });
    const res = await makeClient().matchers.update(55, { name: 'Plain' });
    expect(res).toEqual({ id: 55, name: 'Plain' });
    expect(spy.calls[0]?.url).toBe('https://hudu.example.com/api/v1/matchers/55');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = routed({ '/api/v1/matchers/55': () => json(matcher()) });
    const client = makeClient({ onAudit: audit.onAudit });
    await client.matchers.update(55, { name: 'x' });
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'invalid' }, 422));
    const err = await rejection(client.matchers.update(55, { name: 'x' }));
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.correlationId).toMatch(UUID);
  });

  it('finds the matcher by its sync id without a scan', async () => {
    const spy = routed({ '/api/v1/matchers': matcherPages([matcher()]) });
    const res = await makeClient().matchers.resolve({ sync_id: 29683607, integration_id: 4 });
    expect(res).toEqual(matcher());
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('sync_id=29683607');
    expect(spy.calls[0]?.url).toContain('integration_id=4');
    const detailed = await makeClient().matchers.resolve({ sync_id: 29683607, integration_id: 4 }, { resolutionDetails: true });
    expect(detailed).toMatchObject({ resolutionCost: 'server-filter', scanTruncated: false });
    expect(detailed.candidates).toEqual([{ id: 55, label: 'Green Mile 24' }]);
  });

  it('falls back to a bounded client scan', async () => {
    const items = [matcher({ id: 1 }), matcher({ id: 2 }), matcher({ id: 55 })];
    const spy = routed({ '/api/v1/matchers': matcherPages(items) });
    const res = await makeClient().matchers.resolve({ id: 55, integration_id: 4 });
    expect(res).toEqual(matcher({ id: 55 }));
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('integration_id=4');
    expect(spy.calls[0]?.url).not.toContain('/matchers/55');
  });

  it('throws NOT_FOUND when the complete scan has no match', async () => {
    routed({ '/api/v1/matchers': matcherPages([matcher({ id: 1 })]) });
    const err = await rejection(makeClient().matchers.resolve({ id: 999, integration_id: 4 }));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('throws RESOLUTION_TRUNCATED instead of null when the scan hits the cap', async () => {
    const spy = routed({ '/api/v1/matchers': endlessMatcherPages() });
    const err = await rejection(makeClient().matchers.resolve({ id: 999, integration_id: 4 }));
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.category).toBe('resolution');
    // The scan is bounded: at most 4 pages of 25 records, whatever the server claims.
    expect(spy.calls).toHaveLength(4);
  });

  it('returns the matcher for the sync id', async () => {
    const spy = routed({ '/api/v1/matchers': matcherPages([matcher()]) });
    const res = await makeClient().matchers.findBySyncId(29683607, 4);
    expect(res).toEqual([matcher()]);
    expect(spy.calls[0]?.url).toContain('sync_id=29683607');
    expect(spy.calls[0]?.url).toContain('integration_id=4');
  });

  it('returns an empty array when nothing is matched', async () => {
    routed({ '/api/v1/matchers': matcherPages([]) });
    await expect(makeClient().matchers.findBySyncId(1, 4)).resolves.toEqual([]);
  });

  it('honours limit and never exceeds 100', async () => {
    const items = Array.from({ length: 60 }, (_v, index) => matcher({ id: index + 1, sync_id: 7 }));
    const spy = routed({ '/api/v1/matchers': matcherPages(items) });
    const client = makeClient();
    const res = await client.matchers.findBySyncId(7, 4, { limit: 30 });
    expect(res).toHaveLength(30);
    await expect(client.matchers.findBySyncId(7, 4, { limit: 101 })).rejects.toThrow(HuduConfigError);
    expect(spy.calls.length).toBeLessThanOrEqual(3);
    // A bare identifier cannot carry the integration the vendor requires: refused, not guessed.
    await expect(client.matchers.resolve(55)).rejects.toThrow(HuduConfigError);
  });
});

describe('MatchersResource — resolution edge cases', () => {
  afterEach(() => clearFetch());

  it('resolves an external identifier through the vendor filter', async () => {
    const spy = routed({ '/api/v1/matchers': matcherPages([matcher()]) });
    const res = await makeClient().matchers.resolve({ identifier: 'green-mile-24', integration_id: 4 });
    expect(res).toEqual(matcher());
    expect(spy.calls[0]?.url).toContain('identifier=green-mile-24');
  });

  it('rejects identifier kinds and bounds the vendor requires', async () => {
    const spy = routed({ '/api/v1/matchers': matcherPages([matcher()]) });
    const client = makeClient();
    await expect(client.matchers.resolve('green-mile-24')).rejects.toThrow(HuduConfigError);
    await expect(client.matchers.resolve(55)).rejects.toThrow(HuduConfigError);
    await expect(client.matchers.resolve({})).rejects.toThrow(HuduConfigError);
    await expect(client.matchers.resolve({ id: 55 })).rejects.toThrow(HuduConfigError);
    await expect(client.matchers.resolve({ integration_id: 4 })).rejects.toThrow(HuduConfigError);
    await expect(client.matchers.resolve({ sync_id: 1, integration_id: 0 })).rejects.toThrow(HuduConfigError);
    await expect(client.matchers.findBySyncId(1.5, 4)).rejects.toThrow(HuduConfigError);
    await expect(client.matchers.findBySyncId(1, 0)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
    await expect(client.matchers.findBySyncId(1, 4, { limit: 101 })).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('iterates list and listPages and resolves with the details view', async () => {
    routed({ '/api/v1/matchers': matcherPages([matcher()]) });
    const client = makeClient();
    const items: unknown[] = [];
    for await (const record of client.matchers.list({ integration_id: 4 })) items.push(record);
    expect(items).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of client.matchers.listPages({ integration_id: 4 })) pages.push(page);
    expect(pages).toHaveLength(1);
    const detailed = await client.matchers.resolve({ id: 55, integration_id: 4 }, { resolutionDetails: true });
    expect(detailed).toMatchObject({ resolutionCost: 'client-scan', scanTruncated: false });
    expect(detailed.candidates).toEqual([{ id: 55, label: 'Green Mile 24' }]);
  });
});

describe('MatchersResource — bounded candidate collection', () => {
  afterEach(() => clearFetch());

  it('stops at the first collected candidate when limit is 1', async () => {
    const spy = routed({ '/api/v1/matchers': matcherPages([matcher(), matcher({ id: 56 })]) });
    const client = makeClient();
    await expect(client.matchers.resolve({ sync_id: 29683607, integration_id: 4 }, { limit: 1 })).resolves.toMatchObject({ id: 55 });
    await expect(client.matchers.resolve({ id: 55, integration_id: 4 }, { limit: 1 })).resolves.toMatchObject({ id: 55 });
    expect(spy.calls).toHaveLength(2);
  });
});

describe('MatchersResource — expectedUpdatedAt is refused on every path', () => {
  afterEach(() => clearFetch());

  it('refuses the guard on update and delete (staleCheck is unavailable)', async () => {
    const spy = routed({});
    const client = makeClient();
    const guard = { expectedUpdatedAt: '2024-05-01T00:00:00Z' };
    for (const call of [client.matchers.update(55, { name: 'x' }, guard), client.matchers.delete(55, guard)]) {
      const err = await rejection(call);
      expect(err.code).toBe('CONFIG_ERROR');
      expect(err.message).toContain('update (PUT) only');
    }
    expect(spy.calls).toHaveLength(0);
  });
});

describe('MatchersResource — executed audit impact equals the dry-run impact', () => {
  afterEach(() => clearFetch());

  it('reports the SAME impact for update and delete', async () => {
    const audit = auditSpy();
    const spy = routed({
      '/api/v1/matchers/55': () => json(matcher()),
    });
    spy.setHandler((_raw, init) => (init.method === 'DELETE' ? empty(204) : json(matcher())));
    const client = makeClient({ onAudit: audit.onAudit });
    const describedUpdate = await client.matchers.update(55, { name: 'x' }, { dryRun: true });
    await client.matchers.update(55, { name: 'x' });
    const describedDelete = await client.matchers.delete(55, { dryRun: true });
    await client.matchers.delete(55);
    const executed = audit.events.filter((event) => !event.dryRun && event.effect !== 'read');
    expect(executed.map((event) => event.impact)).toEqual([
      { affected: 1, scope: 'single', reversible: true },
      { affected: 1, scope: 'single', reversible: false },
    ]);
    expect(executed[0]?.impact).toEqual(describedUpdate.impact);
    expect(executed[1]?.impact).toEqual(describedDelete.impact);
    expect(spy.calls.map((call) => call.init.method)).toEqual(['PUT', 'DELETE']);
  });
});
