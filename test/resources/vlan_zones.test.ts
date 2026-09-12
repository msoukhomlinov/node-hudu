/**
 * vlan_zones — primitive rows and the agent-execution-layer helper tier (`resolve`).
 * Uses the shared mocked-fetch helper; never touches the network. Test titles are
 * copied verbatim from `capabilities.plan.json`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduError, NotFoundError, ResolutionError, StaleObjectError, ValidationFailedError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { VlanZoneIdentifier, VlanZoneSummary } from '../../src/types/vlan_zone.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/vlan_zones';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fields the compact `VlanZoneSummary` must drop (policy §9). */
const DROPPED: string[] = ['description', 'archived_at', 'created_at'];

const ZONE = {
  id: 7,
  name: 'Core',
  slug: 'core',
  description: 'a description',
  vlan_id_ranges: '100-500',
  company_id: 3,
  archived_at: '',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  vlans_count: 4,
  url: 'https://hudu.example.com/vlan_zones/7',
};

const SUMMARY: VlanZoneSummary = {
  id: 7,
  name: 'Core',
  slug: 'core',
  vlan_id_ranges: '100-500',
  company_id: 3,
  vlans_count: 4,
  url: 'https://hudu.example.com/vlan_zones/7',
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

describe('vlan_zones primitives', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped vlan_zones list', async () => {
    const spy = stubFetch(() => json([ZONE]));
    expect(await makeClient().vlanZones.listAll()).toEqual([ZONE]);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(BASE);
  });

  it('never sends page/page_size to the non-paginated endpoint', async () => {
    const spy = stubFetch(() => json([ZONE]));
    await makeClient().vlanZones.listAll({ page: 4, page_size: 50 });
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).not.toContain('page');
  });

  it('returns the unwrapped vlan_zones record', async () => {
    const spy = stubFetch(() => json(ZONE));
    expect(await makeClient().vlanZones.get(7)).toEqual(ZONE);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().vlanZones.get(7));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('returns the created vlan_zones record', async () => {
    const spy = stubFetch(() => json(ZONE));
    const res = await makeClient().vlanZones.create({ name: 'Core', vlan_id_ranges: '100-500' });
    expect(res).toEqual(ZONE);
    expect(spy.calls[0]?.init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(ZONE));
    const res = await makeClient().vlanZones.create({ name: 'Core' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('vlan_zones.create');
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('returns the updated vlan_zones record', async () => {
    const spy = stubFetch(() => json({ ...ZONE, name: 'Renamed' }));
    expect(await makeClient().vlanZones.update(7, { name: 'Renamed' })).toEqual({ ...ZONE, name: 'Renamed' });
    expect(spy.calls[0]?.init.method).toBe('PUT');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(ZONE));
    const res = await makeClient().vlanZones.update(7, { name: 'x' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('vlan_zones.update');
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `vlan_zones` declares no singleKey: the shared PUT path is an identity unwrap.
    stubFetch(() => json({ ...ZONE, name: 'Renamed' }));
    expect(await makeClient().vlanZones.update(7, { name: 'Renamed' })).toEqual({ ...ZONE, name: 'Renamed' });
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    expect(await makeClient().vlanZones.delete(7)).toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const res = await makeClient().vlanZones.delete(7, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('vlan_zones.delete');
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    stubFetch(() => json(ZONE));
    await client.vlanZones.get(7);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    const errSpy = stubFetch(() => json({ error: 'nope' }, 404));
    const err = await rejection(client.vlanZones.get(9));
    expect(errSpy.calls).toHaveLength(1);
    expect(err.correlationId).toMatch(UUID);
    const last = audit.events[audit.events.length - 1] as AuditEvent;
    expect(last.outcome).toBe('error');
    expect(last.correlationId).toBe(err.correlationId);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const spy = stubFetch(() => json({ ...ZONE, updated_at: '2026-02-02T00:00:00Z' }));
    const err = await rejection(
      makeClient().vlanZones.update(7, { name: 'x' }, { expectedUpdatedAt: ZONE.updated_at }),
    );
    expect(err).toBeInstanceOf(StaleObjectError);
    expect(err.code).toBe('STALE_OBJECT');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('GET');
  });

  it('issues the write when the expectedUpdatedAt revision still matches', async () => {
    const spy = stubFetch(() => json(ZONE));
    expect(await makeClient().vlanZones.update(7, { name: 'x' }, { expectedUpdatedAt: ZONE.updated_at })).toEqual(ZONE);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1]?.init.method).toBe('PUT');
  });
});

describe('vlan_zones.resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(ZONE));
    expect(await makeClient().vlanZones.resolve({ id: 7 })).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().vlanZones.resolve({ id: 999 }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the single exact match', async () => {
    const other = { ...ZONE, id: 8, name: 'Edge', slug: 'edge' };
    const spy = stubFetch(() => json([other, ZONE]));
    expect(await makeClient().vlanZones.resolve({ name: 'Core' })).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toContain('name=Core');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([]));
    expect(await makeClient().vlanZones.resolve('nope')).toBeNull();
    // slug (one complete collection read) then the vendor name filter: no page params
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);
  });

  it('resolves a slug with one complete collection read', async () => {
    const spy = stubFetch(() => json([ZONE]));
    const res = await makeClient().vlanZones.resolve('core', { resolutionDetails: true });
    expect(res.value).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(BASE);
    // no vendor slug filter exists, so the honest cost is a client scan
    expect(res.resolutionCost).toBe('client-scan');
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids when several zones match', async () => {
    const first = { ...ZONE, id: 11, name: 'Dup', slug: 'dup-1' };
    const second = { ...ZONE, id: 12, name: 'Dup', slug: 'dup-2' };
    stubFetch(() => json([first, second]));
    const err = await rejection(makeClient().vlanZones.resolve('Dup'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([11, 12]);
  });

  it('rejects an identifier kind the vendor cannot support instead of guessing', async () => {
    const spy = stubFetch(() => json(ZONE));
    const err = await rejection(makeClient().vlanZones.resolve({ vlan_id: 100 } as VlanZoneIdentifier));
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect(err.message).toContain('id, slug, exact name');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns VlanZoneSummary', async () => {
    stubFetch(() => json(ZONE));
    const res = await makeClient().vlanZones.resolve({ id: 7 });
    expect(res).toEqual(SUMMARY);
    expect(Object.keys(res as object).sort()).toEqual(Object.keys(SUMMARY).sort());
    for (const field of DROPPED) expect(res).not.toHaveProperty(field);
  });

  it('expand: true returns the full zone', async () => {
    stubFetch(() => json(ZONE));
    const res = await makeClient().vlanZones.resolve({ id: 7 }, { expand: true });
    expect(res).toEqual(ZONE);
    expect(res).toHaveProperty('vlan_id_ranges', '100-500');
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap is reached', async () => {
    const client = makeClient({ resolution: { maxScanRecords: 1 } });
    const a = { ...ZONE, id: 21, name: 'A', slug: 'a' };
    const b = { ...ZONE, id: 22, name: 'B', slug: 'b' };
    stubFetch(() => json([a, b]));
    const err = await rejection(client.vlanZones.resolve('core'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
  });
});

describe('vlan_zones streaming and validation surface', () => {
  afterEach(() => clearFetch());

  it('streams the collection and yields single-page batches', async () => {
    const spy = stubFetch(() => json([ZONE]));
    const client = makeClient();
    const streamed = [];
    for await (const item of client.vlanZones.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages = [];
    for await (const page of client.vlanZones.listPages()) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.hasMore).toBe(false);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);
  });

  it('returns a null-valued Resolution after a complete scan', async () => {
    stubFetch(() => json([]));
    const res = await makeClient().vlanZones.resolve('nope', { resolutionDetails: true });
    expect(res.value).toBeNull();
    expect(res.scanTruncated).toBe(false);
    expect(res.candidates).toBeUndefined();
  });

  it('names the accepted kinds for every unsupported identifier form', async () => {
    const spy = stubFetch(() => json(ZONE));
    const client = makeClient();
    await expect(client.vlanZones.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlanZones.resolve({ id: 1.5 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlanZones.resolve(null as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlanZones.resolve([] as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlanZones.resolve({ slug: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlanZones.resolve({ name: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.vlanZones.resolve('   ')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('vlan_zones identifier kinds and guards', () => {
  afterEach(() => clearFetch());

  it('does not read before a delete (the stale guard lives on update only)', async () => {
    // registry staleCheck for vlan_zones.delete is "unavailable": no read-then-compare.
    const spy = stubFetch(() => empty(204));
    expect(await makeClient().vlanZones.delete(7, { expectedUpdatedAt: ZONE.updated_at })).toBeUndefined();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('DELETE');
  });

  it('falls back from the slug kind to the vendor name filter', async () => {
    const renamed = { ...ZONE, slug: 'renamed' };
    const spy = stubFetch(() => json([renamed]));
    expect(await makeClient().vlanZones.resolve('Core')).toEqual({ ...SUMMARY, slug: 'renamed' });
    expect(spy.calls).toHaveLength(2);
    expect(urlOf(spy)).toBe(BASE);
    expect(urlOf(spy, 1)).toContain('name=Core');
  });

  it('accepts a numeric string as an id', async () => {
    const spy = stubFetch(() => json(ZONE));
    expect(await makeClient().vlanZones.resolve('7')).toEqual(SUMMARY);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });
});
