/**
 * LabelsResource — agent-execution-layer coverage: `resolve` (by id or by the record a
 * label is attached to) and `findByLabelable`, plus dry-run, correlation ids and the
 * opt-in stale guard. Mocked fetch only; never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduError, HuduConfigError, NotFoundError, ResolutionError, StaleObjectError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { Label } from '../../src/types/label.js';
import { clearFetch, empty, json, stubFetch } from '../helpers.js';
import type { SpyCall } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/labels';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeClient(overrides: Record<string, unknown> = {}): HuduClient {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...overrides });
}

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

function query(call: SpyCall): URLSearchParams {
  return new URL(call.url).searchParams;
}

function makeLabel(id: number, labelableId = 5, labelTypeId = 1): Label {
  return {
    id,
    label_type_id: labelTypeId,
    labelable_type: 'Asset',
    labelable_id: labelableId,
    user_id: 7,
    created_at: '2025-12-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const LABEL = makeLabel(1);
const SECOND = makeLabel(2);
const UNRELATED = makeLabel(3, 99);

const SUMMARY = {
  id: 1,
  label_type_id: 1,
  labelable_type: 'Asset',
  labelable_id: 5,
  user_id: 7,
  updated_at: '2026-01-01T00:00:00Z',
};

/** A full page of labels that do not carry the requested pair. */
function page(startId: number): Label[] {
  return Array.from({ length: 25 }, (_, i) => makeLabel(startId + i, 900 + i));
}

describe('labels.resolve (helper tier)', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ label: LABEL }));
    const found = await makeClient().labels.resolve(1);
    expect(found).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'nope' }, 404));
    const err = await rejection(makeClient().labels.resolve(999));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(spy.calls).toHaveLength(1);
  });

  it('returns LabelSummary', async () => {
    stubFetch(() => json({ label: LABEL }));
    const found = await makeClient().labels.resolve(1);
    expect(found).toEqual(SUMMARY);
    expect(found).not.toHaveProperty('created_at');
  });

  it('expand: true returns the full label', async () => {
    stubFetch(() => json({ label: LABEL }));
    await expect(makeClient().labels.resolve(1, { expand: true })).resolves.toEqual(LABEL);
  });

  it('throws RESOLUTION_AMBIGUOUS when a record carries several labels', async () => {
    const spy = stubFetch(() => json({ labels: [LABEL, SECOND] }));
    const err = await rejection(
      makeClient().labels.resolve({ labelableType: 'Asset', labelableId: 5 }),
    );
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 2]);
    expect(err.message).toContain('several labels are attached to Asset 5');
    // The pair filter reached the non-paginated-safe path: one bounded scan plus the
    // uniqueness pass, both against the vendor pair filter.
    expect(spy.calls).toHaveLength(2);
    expect(query(spy.calls[0]!).get('labelable_type')).toBe('Asset');
    expect(query(spy.calls[0]!).get('labelable_id')).toBe('5');
  });

  it('resolves the single label attached to a record', async () => {
    const spy = stubFetch(() => json({ labels: [UNRELATED, LABEL] }));
    const found = await makeClient().labels.resolve({ labelableType: 'Asset', labelableId: 5 });
    expect(found).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(2);
  });

  it('resolutionDetails reports the pair scan, including a complete-scan miss', async () => {
    stubFetch(() => json({ labels: [UNRELATED, LABEL] }));
    const hit = await makeClient().labels.resolve(
      { labelableType: 'Asset', labelableId: 5 },
      { resolutionDetails: true },
    );
    expect(hit.value).toEqual(SUMMARY);
    expect(hit.resolutionCost).toBe('server-filter');

    stubFetch(() => json({ labels: [] }));
    const miss = await makeClient().labels.resolve(
      { labelableType: 'Asset', labelableId: 5 },
      { resolutionDetails: true },
    );
    expect(miss).toEqual({ value: null, resolutionCost: 'server-filter', scanned: 0, scanTruncated: false });
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap stops the search', async () => {
    const spy = stubFetch(() => json({ labels: page(100) }));
    const err = await rejection(
      makeClient().labels.resolve({ labelableType: 'Asset', labelableId: 5 }),
    );
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(spy.calls).toHaveLength(4);
  });

  it('throws RESOLUTION_TRUNCATED when the uniqueness pass hits the cap', async () => {
    const spy = stubFetch((url: string) => {
      const p = Number(new URL(url).searchParams.get('page') ?? '1');
      if (p === 3) return json({ labels: [LABEL, ...page(200).slice(0, 24)] });
      return json({ labels: page(300 + p * 25) });
    });
    const err = await rejection(
      makeClient().labels.resolve({ labelableType: 'Asset', labelableId: 5 }),
    );
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(spy.calls).toHaveLength(7);
  });

  it('reports cost and scanned through resolutionDetails', async () => {
    stubFetch(() => json({ label: LABEL }));
    const resolution = await makeClient().labels.resolve(1, { resolutionDetails: true });
    expect(resolution.resolutionCost).toBe('direct');
    expect(resolution.scanned).toBe(1);
    expect(resolution.value).toEqual(SUMMARY);
  });

  it('refuses an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json({ labels: [] }));
    const err = await rejection(makeClient().labels.resolve('Critical'));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.message).toContain('a label has no name');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('labels.findByLabelable (helper tier)', () => {
  afterEach(() => clearFetch());

  it('returns the labels of the record', async () => {
    // The vendor pair filter decides the set; the helper does not second-guess it.
    const spy = stubFetch(() => json({ labels: [LABEL, SECOND] }));
    const found = await makeClient().labels.findByLabelable('Asset', 5);
    expect(found).toEqual([SUMMARY, { ...SUMMARY, id: 2 }]);
    // One call, one page: the helper never pages past what the caller asked for.
    expect(spy.calls).toHaveLength(1);
    expect(query(spy.calls[0]!).get('labelable_type')).toBe('Asset');
    expect(query(spy.calls[0]!).get('labelable_id')).toBe('5');
    expect(query(spy.calls[0]!).get('page_size')).toBe('25');
  });

  it('returns an empty array for an unlabelled record', async () => {
    const spy = stubFetch(() => json({ labels: [] }));
    await expect(makeClient().labels.findByLabelable('Article', 42)).resolves.toEqual([]);
    expect(spy.calls).toHaveLength(1);
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = stubFetch(() => json({ labels: [LABEL, SECOND] }));
    const client = makeClient();
    const many = await client.labels.findByLabelable('Asset', 5, { limit: 100 });
    expect(many).toHaveLength(2);
    expect(query(spy.calls[0]!).get('page_size')).toBe('100');

    const one = await client.labels.findByLabelable('Asset', 5, { limit: 1 });
    expect(one).toHaveLength(1);

    const err = await rejection(client.labels.findByLabelable('Asset', 5, { limit: 101 }));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.message).toContain('limit must be <= 100');
    const bad = await rejection(client.labels.findByLabelable('Asset', 5, { limit: 0 }));
    expect(bad).toBeInstanceOf(HuduConfigError);
  });

  it('expand: true returns the full records', async () => {
    stubFetch(() => json({ labels: [LABEL, SECOND, UNRELATED] }));
    const found = await makeClient().labels.findByLabelable('Asset', 5, { expand: true });
    expect(found).toEqual([LABEL, SECOND, UNRELATED]);
    expect(found[0]).toHaveProperty('created_at');
  });
});

describe('labels primitives (list/get)', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped labels list', async () => {
    const spy = stubFetch(() => json({ labels: [LABEL] }));
    await expect(makeClient().labels.listAll({})).resolves.toEqual([LABEL]);
    expect(spy.calls[0]!.url).toContain(BASE);
  });

  it('sends page/page_size and stops on a short page', async () => {
    let n = 0;
    const spy = stubFetch(() => {
      n += 1;
      return n === 1 ? json({ labels: page(1) }) : json({ labels: [LABEL] });
    });
    const all = await makeClient().labels.listAll({});
    expect(all).toHaveLength(26);
    expect(spy.calls).toHaveLength(2);
    expect(query(spy.calls[0]!).get('page_size')).toBe('25');
    expect(query(spy.calls[1]!).get('page')).toBe('2');
  });

  it('streams the list and its pages', async () => {
    stubFetch(() => json({ labels: [LABEL] }));
    const items: Label[] = [];
    for await (const item of makeClient().labels.list({})) items.push(item);
    expect(items).toEqual([LABEL]);

    const pages = [];
    for await (const item of makeClient().labels.listPages({})) pages.push(item);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.items).toEqual([LABEL]);
  });

  it('returns the unwrapped labels record', async () => {
    const spy = stubFetch(() => json({ label: LABEL }));
    await expect(makeClient().labels.get(1)).resolves.toEqual(LABEL);
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(rejection(makeClient().labels.get(404))).resolves.toBeInstanceOf(NotFoundError);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? json({ labels: [LABEL] }) : json({ error: 'nope' }, 404);
    });
    await client.labels.listAll({});
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    const err = await rejection(client.labels.get(9));
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
  });
});

describe('labels mutations (dry-run, stale guard, correlation)', () => {
  afterEach(() => clearFetch());

  it('returns the created labels record', async () => {
    const spy = stubFetch(() => json({ label: LABEL }, 201));
    await expect(makeClient().labels.create({ label_type_id: 1 })).resolves.toEqual(LABEL);
    expect(spy.calls[0]!.init.body).toBe(JSON.stringify({ label: { label_type_id: 1 } }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ label: LABEL }));
    const result = await makeClient().labels.create({ label_type_id: 1 }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('labels.create');
    expect(result.checks.some((check) => check.ok)).toBe(true);
  });

  it('refuses expectedUpdatedAt on a create with CONFIG_ERROR', async () => {
    const spy = stubFetch(() => json({ label: LABEL }));
    const err = await rejection(
      makeClient().labels.create({ label_type_id: 1 }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns the updated labels record', async () => {
    const spy = stubFetch(() => json({ label: LABEL }));
    await expect(makeClient().labels.update(1, { label_type_id: 2 })).resolves.toEqual(LABEL);
    expect(spy.calls[0]!.init.method).toBe('PUT');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ label: LABEL }));
    const result = await makeClient().labels.update(1, { label_type_id: 2 }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'PUT', path: '/labels/1' });
    expect(result.diff).toBeUndefined();
  });

  it('unwraps the PUT response by singleKey', async () => {
    stubFetch(() => json({ label: LABEL }));
    const updated = await makeClient().labels.update(1, { label_type_id: 2 });
    expect(updated).toEqual(LABEL);
    expect(updated).not.toHaveProperty('label');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? json({ label: LABEL }) : json({ error: 'nope' }, 422);
    });
    await client.labels.update(1, { label_type_id: 2 });
    expect(audit.events[0]!.operation).toBe('labels.update');
    const err = await rejection(client.labels.update(1, { label_type_id: 2 }));
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const stale = { ...LABEL, updated_at: '2026-02-02T00:00:00Z' };
    const spy = stubFetch(() => json({ label: stale }));
    const err = await rejection(
      makeClient().labels.update(1, { label_type_id: 2 }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(StaleObjectError);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.init.method).toBe('GET');
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().labels.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0]!.init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const result = await makeClient().labels.delete(1, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.warnings).toContain('dry-run does not inspect dependent records');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? empty(204) : json({ error: 'nope' }, 404);
    });
    await client.labels.delete(1);
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    const err = await rejection(client.labels.delete(404));
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
  });

  it('refuses expectedUpdatedAt on a delete with CONFIG_ERROR', async () => {
    const spy = stubFetch(() => json({ label: LABEL }));
    const err = await rejection(makeClient().labels.delete(1, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(spy.calls).toHaveLength(0);
  });
});
