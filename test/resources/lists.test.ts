/**
 * ListsResource — agent-execution-layer coverage: the helper tier (`resolve`,
 * `findByName`), dry-run, correlation ids and the opt-in stale guard, plus the
 * non-paginated primitive contract. Mocked fetch only; never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduError, HuduConfigError, NotFoundError, ResolutionError, StaleObjectError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { List } from '../../src/types/list.js';
import type { ListsHelperOptions } from '../../src/resources/lists.js';
import { clearFetch, empty, json, stubFetch } from '../helpers.js';
import type { SpyCall } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/lists';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeClient(overrides: Record<string, unknown> = {}): HuduClient {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...overrides });
}

/** Capture the audit events the client reports (correlation id assertions). */
function auditSpy(): { events: AuditEvent[]; hook: (event: AuditEvent) => void } {
  const events: AuditEvent[] = [];
  return { events, hook: (event) => { events.push(event); } };
}

async function rejection(promise: Promise<unknown>): Promise<HuduError> {
  try {
    await promise;
  } catch (err) {
    return err as HuduError;
  }
  throw new Error('expected the promise to reject');
}

/** The query string of a recorded call (never the full URL). */
function query(call: SpyCall): string {
  const url = new URL(call.url);
  return url.search;
}

function makeList(id: number, name: string, updated_at = '2026-01-01T00:00:00Z'): List {
  return {
    id,
    name,
    created_at: '2025-12-01T00:00:00Z',
    updated_at,
    list_items: [],
  };
}

const ALPHA = makeList(1, 'Alpha');
const BETA = makeList(2, 'Beta');

describe('lists.resolve (helper tier)', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(ALPHA));
    const found = await makeClient().lists.resolve(1);
    expect(found).toEqual(ALPHA);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'nope' }, 404));
    const err = await rejection(makeClient().lists.resolve(999));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the single exact match', async () => {
    // The vendor `name` filter narrows, the exact compare decides. Two passes are
    // issued: the first finds the match, the second proves it is unique.
    const spy = stubFetch(() => json([BETA, ALPHA]));
    const found = await makeClient().lists.resolve('Alpha');
    expect(found).toEqual(ALPHA);
    expect(spy.calls).toHaveLength(2);
    // GET /lists is non-paginated: page/page_size must never reach it.
    for (const call of spy.calls) {
      expect(query(call)).toContain('name=Alpha');
      expect(query(call)).not.toContain('page');
    }
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([BETA]));
    const found = await makeClient().lists.resolve('Does Not Exist');
    expect(found).toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('throws RESOLUTION_AMBIGUOUS when several lists share a name', async () => {
    const duplicate = makeList(2, 'Alpha');
    const spy = stubFetch(() => json([ALPHA, duplicate]));
    const err = await rejection(makeClient().lists.resolve('Alpha'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.category).toBe('resolution');
    expect(err.resourceIds).toEqual([1, 2]);
    expect(spy.calls).toHaveLength(2);
  });

  it('reports the resolution cost and scanned count with resolutionDetails', async () => {
    stubFetch(() => json([ALPHA]));
    const resolution = await makeClient().lists.resolve('Alpha', { resolutionDetails: true });
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.value).toEqual(ALPHA);
    expect(resolution.scanned).toBeGreaterThan(0);
  });


  it('resolutionDetails reports the direct cost without a scan', async () => {
    stubFetch(() => json(ALPHA));
    const resolution = await makeClient().lists.resolve(1, { resolutionDetails: true });
    expect(resolution).toEqual({ value: ALPHA, resolutionCost: 'direct', scanned: 1, scanTruncated: false });
  });

  it('resolve({ id }) fetches directly and resolve({ name }) scans', async () => {
    const spy = stubFetch(() => json(ALPHA));
    const byId = await makeClient().lists.resolve({ id: 1 });
    expect(byId).toEqual(ALPHA);
    expect(spy.calls).toHaveLength(1);

    spy.setHandler(() => json([ALPHA]));
    const byName = await makeClient().lists.resolve({ name: 'Alpha' });
    expect(byName).toEqual(ALPHA);
  });

  it('refuses an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json([]));
    const err = await rejection(makeClient().lists.resolve({ query: 'Alpha' } as never));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.message).toContain('lists.resolve accepts');
    expect(spy.calls).toHaveLength(0);
  });

  it('never reports truncation for the non-paginated collection, however many rows it holds', async () => {
    const many = Array.from({ length: 500 }, (_, i) => makeList(i + 10, `List ${i + 10}`));
    const spy = stubFetch(() => json(many));
    const found = await makeClient().lists.resolve('Missing');
    expect(found).toBeNull();
    // One bounded fetch: /lists has no page cap to hit.
    expect(spy.calls).toHaveLength(1);
  });
});

describe('lists.findByName (helper tier)', () => {
  afterEach(() => clearFetch());

  it('returns the exact name match', async () => {
    const spy = stubFetch(() => json([ALPHA, BETA]));
    const found = await makeClient().lists.findByName('Beta');
    expect(found).toEqual(BETA);
    expect(spy.calls[0]!.url).toContain('name=Beta');
  });

  it('returns null after a complete scan', async () => {
    stubFetch(() => json([ALPHA]));
    await expect(makeClient().lists.findByName('Gamma')).resolves.toBeNull();
  });
});


describe('helper options are exactly the options the helpers honour', () => {
  it('lists.resolve / lists.findByName offer resolutionDetails only', () => {
    // Exact-key compile-time guard: this literal stops compiling if an option is added
    // (an accepted-but-ignored `limit`/`expand`/`resolutionDetails`) or removed.
    const keys: Record<keyof ListsHelperOptions, true> = { resolutionDetails: true };
    expect(Object.keys(keys).sort()).toEqual(['resolutionDetails']);
  });
});

describe('lists primitives (list/get)', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped lists list', async () => {
    const spy = stubFetch(() => json([ALPHA, BETA]));
    await expect(makeClient().lists.listAll({})).resolves.toEqual([ALPHA, BETA]);
    expect(spy.calls[0]!.url).toBe(BASE);
  });

  it('never sends page/page_size to the non-paginated endpoint', async () => {
    const spy = stubFetch(() => json([ALPHA]));
    for await (const _item of makeClient().lists.list({ page: 3, page_size: 50 })) void _item;
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe(BASE);
  });


  it('streams the list and its pages', async () => {
    stubFetch(() => json([ALPHA]));
    const items: List[] = [];
    for await (const item of makeClient().lists.list({})) items.push(item);
    expect(items).toEqual([ALPHA]);

    const pages = [];
    for await (const item of makeClient().lists.listPages({})) pages.push(item);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.items).toEqual([ALPHA]);
  });

  it('returns the unwrapped lists record', async () => {
    const spy = stubFetch(() => json(ALPHA));
    await expect(makeClient().lists.get(1)).resolves.toEqual(ALPHA);
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().lists.get(404));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.httpStatus).toBe(404);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    const spy = stubFetch(() => json([ALPHA]));
    await client.lists.listAll({});
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    expect(audit.events[0]!.operation).toBe('lists.list');
    expect(audit.events[0]!.outcome).toBe('success');

    spy.setHandler(() => json({ error: 'nope' }, 404));
    const err = await rejection(client.lists.get(9));
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events).toHaveLength(2);
    expect(audit.events[1]!.outcome).toBe('error');
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
  });
});

describe('lists mutations (dry-run, stale guard, correlation)', () => {
  afterEach(() => clearFetch());

  it('returns the created lists record', async () => {
    const spy = stubFetch(() => json(ALPHA, 201));
    const created = await makeClient().lists.create({ name: 'Alpha' });
    expect(created).toEqual(ALPHA);
    expect(spy.calls[0]!.init.method).toBe('POST');
    expect(spy.calls[0]!.init.body).toBe(JSON.stringify({ list: { name: 'Alpha' } }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(ALPHA));
    const result = await makeClient().lists.create({ name: 'Alpha' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('lists.create');
    expect(result.request).toEqual({ method: 'POST', path: '/lists' });
    expect(result.wouldApply).toBe(true);
    expect(result.checks.some((check) => check.name === 'payload-present')).toBe(true);
  });

  it('refuses expectedUpdatedAt on a create with CONFIG_ERROR', async () => {
    // `staleCheck` is "unavailable" for a create (there is no prior revision to be
    // stale against), so the option is a structural caller error: refused as
    // CONFIG_ERROR, never silently ignored and never reported as STALE_OBJECT.
    const spy = stubFetch(() => json(ALPHA));
    const err = await rejection(
      makeClient().lists.create({ name: 'Alpha' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(err.message).toContain('does not accept expectedUpdatedAt');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns the updated lists record', async () => {
    const spy = stubFetch(() => json(ALPHA));
    await expect(makeClient().lists.update(1, { name: 'Alpha Two' })).resolves.toEqual(ALPHA);
    expect(spy.calls[0]!.init.method).toBe('PUT');
    expect(spy.calls[0]!.init.body).toBe(JSON.stringify({ list: { name: 'Alpha Two' } }));
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(ALPHA));
    const result = await makeClient().lists.update(1, { name: 'x' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'PUT', path: '/lists/1' });
    expect(result.target.ids).toEqual([1]);
    expect(result.checks.some((check) => check.name === 'target-identifier')).toBe(true);
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `lists` declares no singleKey, so unwrapByKey is a documented pass-through:
    // the PUT body is returned unchanged.
    stubFetch(() => json(ALPHA));
    const updated = await makeClient().lists.update(1, { name: 'Alpha' });
    expect(updated).toEqual(ALPHA);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    const spy = stubFetch(() => json(ALPHA));
    await client.lists.update(1, { name: 'Alpha' });
    expect(audit.events[0]!.operation).toBe('lists.update');
    expect(audit.events[0]!.correlationId).toMatch(UUID);

    spy.setHandler(() => json({ error: 'nope' }, 422));
    const err = await rejection(client.lists.update(1, { name: '' }));
    expect(err.operation).toBe('lists.update');
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
    expect(audit.events[1]!.outcome).toBe('error');
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const spy = stubFetch(() => json(makeList(1, 'Alpha', '2026-02-02T00:00:00Z')));
    const err = await rejection(
      makeClient().lists.update(1, { name: 'x' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(StaleObjectError);
    expect(err.code).toBe('STALE_OBJECT');
    // The guard read the record, then refused to issue the PUT.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.init.method).toBe('GET');
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().lists.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0]!.init.method).toBe('DELETE');
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const result = await makeClient().lists.delete(1, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'DELETE', path: '/lists/1' });
    expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    const spy = stubFetch(() => empty(204));
    await client.lists.delete(1);
    expect(audit.events[0]!.operation).toBe('lists.delete');
    expect(audit.events[0]!.effect).toBe('destructive');
    expect(audit.events[0]!.correlationId).toMatch(UUID);

    spy.setHandler(() => json({ error: 'nope' }, 404));
    const err = await rejection(client.lists.delete(404));
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
  });

  it('refuses expectedUpdatedAt on a delete with CONFIG_ERROR', async () => {
    // A delete is bounded by its explicit id and Hudu exposes no conditional delete,
    // so the guard is "unavailable": the option is refused as CONFIG_ERROR and no
    // read-then-compare request is issued.
    const spy = stubFetch(() => json(makeList(1, 'Alpha')));
    const err = await rejection(
      makeClient().lists.delete(1, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(spy.calls).toHaveLength(0);
  });
});
