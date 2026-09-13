/**
 * vlans — primitive rows and the agent-execution-layer helper tier
 * (`resolve`, `findByVlanId`). Uses the shared mocked-fetch helper; never touches the
 * network. Test titles are copied verbatim from `capabilities.plan.json`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError, NotFoundError, ResolutionError, StaleObjectError, ValidationFailedError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { VlanIdentifier, VlanSummary } from '../../src/types/vlan.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/vlans';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fields the compact `VlanSummary` must drop (policy §9). */
const DROPPED: string[] = ['description', 'notes', 'archived_at', 'created_at'];

const VLAN = {
  id: 7,
  name: 'Data',
  slug: 'data',
  vlan_id: 100,
  description: 'a description',
  notes: 'some notes',
  company_id: 3,
  vlan_zone_id: 4,
  status_list_item_id: 5,
  role_list_item_id: 6,
  archived_at: '',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  networks_count: 2,
  url: 'https://hudu.example.com/vlans/7',
};

const SUMMARY: VlanSummary = {
  id: 7,
  name: 'Data',
  slug: 'data',
  vlan_id: 100,
  company_id: 3,
  vlan_zone_id: 4,
  status_list_item_id: 5,
  role_list_item_id: 6,
  networks_count: 2,
  url: 'https://hudu.example.com/vlans/7',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeClient(overrides: Record<string, unknown> = {}) {
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
  throw new Error('expected the call to reject');
}

function urlOf(spy: { calls: { url: string }[] }, index = 0): string {
  return spy.calls[index]?.url ?? '';
}

describe('vlans primitives', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped vlans list', async () => {
    const spy = stubFetch(() => json([VLAN]));
    expect(await makeClient().vlans.listAll()).toEqual([VLAN]);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(BASE);
  });

  it('never sends page/page_size to the non-paginated endpoint', async () => {
    const spy = stubFetch(() => json([VLAN]));
    await makeClient().vlans.listAll({ page: 2, page_size: 5 });
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).not.toContain('page');
  });

  it('returns the unwrapped vlans record', async () => {
    const spy = stubFetch(() => json(VLAN));
    expect(await makeClient().vlans.get(7)).toEqual(VLAN);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().vlans.get(7));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('returns the created vlans record', async () => {
    const spy = stubFetch(() => json(VLAN));
    const res = await makeClient().vlans.create({ name: 'Data', vlan_id: 100 });
    expect(res).toEqual(VLAN);
    expect(spy.calls[0]?.init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(VLAN));
    const res = await makeClient().vlans.create({ name: 'Data' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('vlans.create');
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('returns the updated vlans record', async () => {
    const spy = stubFetch(() => json({ ...VLAN, name: 'Renamed' }));
    expect(await makeClient().vlans.update(7, { name: 'Renamed' })).toEqual({ ...VLAN, name: 'Renamed' });
    expect(spy.calls[0]?.init.method).toBe('PUT');
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(VLAN));
    const res = await makeClient().vlans.update(7, { name: 'x' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('vlans.update');
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `vlans` declares no singleKey: the shared PUT path is an identity unwrap.
    stubFetch(() => json({ ...VLAN, name: 'Renamed' }));
    expect(await makeClient().vlans.update(7, { name: 'Renamed' })).toEqual({ ...VLAN, name: 'Renamed' });
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    expect(await makeClient().vlans.delete(7)).toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const res = await makeClient().vlans.delete(7, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('vlans.delete');
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    stubFetch(() => json(VLAN));
    await client.vlans.get(7);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    const errSpy = stubFetch(() => json({ error: 'nope' }, 404));
    const err = await rejection(client.vlans.get(9));
    expect(errSpy.calls).toHaveLength(1);
    expect(err.correlationId).toMatch(UUID);
    const last = audit.events[audit.events.length - 1] as AuditEvent;
    expect(last.outcome).toBe('error');
    expect(last.correlationId).toBe(err.correlationId);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const spy = stubFetch(() => json({ ...VLAN, updated_at: '2026-02-02T00:00:00Z' }));
    const err = await rejection(
      makeClient().vlans.update(7, { name: 'x' }, { expectedUpdatedAt: VLAN.updated_at }),
    );
    expect(err).toBeInstanceOf(StaleObjectError);
    expect(err.code).toBe('STALE_OBJECT');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('GET');
  });

  it('issues the write when the expectedUpdatedAt revision still matches', async () => {
    const spy = stubFetch(() => json(VLAN));
    expect(await makeClient().vlans.update(7, { name: 'x' }, { expectedUpdatedAt: VLAN.updated_at })).toEqual(VLAN);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1]?.init.method).toBe('PUT');
  });
});

describe('vlans.resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(VLAN));
    expect(await makeClient().vlans.resolve({ id: 7 })).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().vlans.resolve({ id: 999 }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the single exact match', async () => {
    const other = { ...VLAN, id: 8, name: 'Voice', slug: 'voice', vlan_id: 200 };
    const spy = stubFetch(() => json([other, VLAN]));
    expect(await makeClient().vlans.resolve('Data')).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toContain('name=Data');
  });

  it('resolves a bare VLAN number through the id then vlan_id kinds', async () => {
    // The documented order is numeric id first: a miss on the id falls through to the
    // vendor `vlan_id` filter.
    const spy = stubFetch((url) => (url.endsWith('/vlans/100') ? json({ error: 'not found' }, 404) : json([VLAN])));
    const res = await makeClient().vlans.resolve(100);
    expect(res).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(2);
    expect(urlOf(spy)).toBe(`${BASE}/100`);
    expect(urlOf(spy, 1)).toContain('vlan_id=100');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([]));
    expect(await makeClient().vlans.resolve('nope')).toBeNull();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);

    // A bare number tries the id first, then the vendor `vlan_id` filter; both miss.
    const idSpy = stubFetch((url) => (url.endsWith('/vlans/4242') ? json({ error: 'not found' }, 404) : json([])));
    expect(await makeClient().vlans.resolve(4242)).toBeNull();
    expect(idSpy.calls).toHaveLength(2);
    expect(urlOf(idSpy, 1)).toContain('vlan_id=4242');
  });

  it('rejects an identifier kind the vendor cannot support instead of guessing', async () => {
    const spy = stubFetch(() => json(VLAN));
    const err = await rejection(makeClient().vlans.resolve({ slug: 'data' } as VlanIdentifier));
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect(err.message).toContain('id, vlan_id, exact name');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns VlanSummary', async () => {
    stubFetch(() => json(VLAN));
    const res = await makeClient().vlans.resolve({ id: 7 });
    expect(res).toEqual(SUMMARY);
    expect(Object.keys(res as object).sort()).toEqual(Object.keys(SUMMARY).sort());
    for (const field of DROPPED) expect(res).not.toHaveProperty(field);
  });

  it('expand: true returns the full VLAN', async () => {
    stubFetch(() => json(VLAN));
    const res = await makeClient().vlans.resolve({ id: 7 }, { expand: true });
    expect(res).toEqual(VLAN);
    expect(res).toHaveProperty('description', 'a description');
  });

  it('returns Resolution<VlanSummary> with the filter cost', async () => {
    stubFetch(() => json([VLAN]));
    const res = await makeClient().vlans.resolve({ vlan_id: 100 }, { resolutionDetails: true });
    expect(res.resolutionCost).toBe('server-filter');
    expect(res.scanTruncated).toBe(false);
    expect(res.value).toEqual(SUMMARY);
    expect(res.candidates).toEqual([{ id: 7, label: 'Data' }]);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap is reached', async () => {
    const client = makeClient({ resolution: { maxScanRecords: 1 } });
    const a = { ...VLAN, id: 21, name: 'A', vlan_id: 300 };
    const b = { ...VLAN, id: 22, name: 'B', vlan_id: 301 };
    stubFetch(() => json([a, b]));
    const err = await rejection(client.vlans.resolve('Data'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
  });
});

describe('vlans.findByVlanId', () => {
  afterEach(() => clearFetch());

  it('returns the exact match', async () => {
    const other = { ...VLAN, id: 8, vlan_id: 101 };
    const spy = stubFetch(() => json([other, VLAN]));
    expect(await makeClient().vlans.findByVlanId(100)).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toContain('vlan_id=100');
  });

  it('returns null after a complete scan for an unknown VLAN number', async () => {
    const spy = stubFetch(() => json([VLAN]));
    expect(await makeClient().vlans.findByVlanId(4094)).toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the full VLAN with expand: true', async () => {
    stubFetch(() => json([VLAN]));
    expect(await makeClient().vlans.findByVlanId(100, { expand: true })).toEqual(VLAN);
  });

  it('throws RESOLUTION_AMBIGUOUS when several networks reuse a VLAN id', async () => {
    const first = { ...VLAN, id: 11, name: 'Site A', vlan_id: 100 };
    const second = { ...VLAN, id: 12, name: 'Site B', vlan_id: 100 };
    stubFetch(() => json([first, second]));
    const err = await rejection(makeClient().vlans.findByVlanId(100));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([11, 12]);
  });
});

describe('vlans streaming and validation surface', () => {
  afterEach(() => clearFetch());

  it('streams the collection and yields single-page batches', async () => {
    const spy = stubFetch(() => json([VLAN]));
    const client = makeClient();
    const streamed = [];
    for await (const item of client.vlans.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages = [];
    for await (const page of client.vlans.listPages()) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.hasMore).toBe(false);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);
  });

  it('returns a null-valued Resolution after a complete scan', async () => {
    stubFetch(() => json([]));
    const res = await makeClient().vlans.resolve('nope', { resolutionDetails: true });
    expect(res.value).toBeNull();
    expect(res.scanTruncated).toBe(false);
    expect(res.candidates).toBeUndefined();
  });

  it('names the accepted kinds for every unsupported identifier form', async () => {
    const spy = stubFetch(() => json(VLAN));
    const client = makeClient();
    await expect(client.vlans.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlans.resolve({ id: 1.5 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlans.resolve({ vlan_id: 1.5 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlans.resolve(null as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlans.resolve([] as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlans.resolve({ name: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlans.resolve('   ')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('vlans identifier kinds and guards', () => {
  afterEach(() => clearFetch());

  it('refuses expectedUpdatedAt on delete with CONFIG_ERROR and issues no request', async () => {
    // registry staleCheck for vlans.delete is "unavailable"; the shared delete path cannot honour the guard,
    // so it refuses instead of silently ignoring it.
    const spy = stubFetch(() => empty(204));
    const err = await rejection(makeClient().vlans.delete(7, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(spy.calls).toHaveLength(0);
  });

  it('accepts a numeric string and rejects a non-integer VLAN number', async () => {
    const client = makeClient();
    const idSpy = stubFetch(() => json(VLAN));
    expect(await client.vlans.resolve('7')).toEqual(SUMMARY);
    expect(urlOf(idSpy)).toBe(`${BASE}/7`);

    const spy = stubFetch(() => json([VLAN]));
    await expect(client.vlans.findByVlanId(1.5)).rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });
});
