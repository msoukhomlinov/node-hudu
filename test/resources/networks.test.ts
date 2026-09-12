/**
 * networks — primitive rows and the agent-execution-layer helper tier
 * (`resolve`, `findByAddress`). Uses the shared mocked-fetch helper; never touches
 * the network. Test titles are copied verbatim from `capabilities.plan.json`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError, NotFoundError, ResolutionError, StaleObjectError, ValidationFailedError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { NetworkIdentifier, NetworkSummary } from '../../src/types/network.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/networks';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fields the compact `NetworkSummary` must drop (policy §9). */
const DROPPED: string[] = [
  'description', 'notes', 'ancestry', 'settings', 'sync_identifier', 'is_radar',
  'created_at', 'archived_at',
];

const NETWORK = {
  id: 7,
  name: 'Main',
  address: '10.0.0.0/24',
  network_type: 1,
  slug: 'main',
  company_id: 3,
  location_id: 4,
  description: 'a description',
  notes: 'some notes',
  ancestry: 'root',
  settings: { dhcp: true },
  sync_identifier: 'sync-1',
  is_radar: false,
  status_list_item_id: 5,
  role_list_item_id: 6,
  vlan_id: 2,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  url: 'https://hudu.example.com/networks/7',
  archived_at: '',
};

const SUMMARY: NetworkSummary = {
  id: 7,
  name: 'Main',
  address: '10.0.0.0/24',
  network_type: 1,
  slug: 'main',
  company_id: 3,
  location_id: 4,
  vlan_id: 2,
  status_list_item_id: 5,
  role_list_item_id: 6,
  url: 'https://hudu.example.com/networks/7',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...overrides });
}

function auditSpy(): { events: AuditEvent[]; hook: (event: AuditEvent) => void } {
  const events: AuditEvent[] = [];
  return { events, hook: (event) => { events.push(event); } };
}

/** Await a promise that must reject, and return the error it rejected with. */
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

describe('networks primitives', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped networks list', async () => {
    const spy = stubFetch(() => json([NETWORK]));
    const res = await makeClient().networks.listAll();
    expect(res).toEqual([NETWORK]);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(BASE);
  });

  it('never sends page/page_size to the non-paginated endpoint', async () => {
    const spy = stubFetch(() => json([NETWORK]));
    await makeClient().networks.listAll({ page: 3, page_size: 10 });
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).not.toContain('page');
    expect(urlOf(spy)).not.toContain('page_size');
  });

  it('returns the unwrapped networks record', async () => {
    const spy = stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.get(7);
    expect(res).toEqual(NETWORK);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().networks.get(7));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('returns the created networks record', async () => {
    const spy = stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.create({ name: 'Main', address: '10.0.0.0/24' });
    expect(res).toEqual(NETWORK);
    expect(spy.calls[0]?.init.method).toBe('POST');
    expect(urlOf(spy)).toBe(BASE);
    expect(JSON.parse(String(spy.calls[0]?.init.body))).toEqual({ name: 'Main', address: '10.0.0.0/24' });
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.create({ name: 'Main' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.wouldApply).toBe(true);
    expect(res.operation).toBe('networks.create');
    expect(res.request).toEqual({ method: 'POST', path: '/networks' });
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('returns the updated networks record', async () => {
    const spy = stubFetch(() => json({ ...NETWORK, name: 'Renamed' }));
    const res = await makeClient().networks.update(7, { name: 'Renamed' });
    expect(res).toEqual({ ...NETWORK, name: 'Renamed' });
    expect(spy.calls[0]?.init.method).toBe('PUT');
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.update(7, { name: 'x' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('networks.update');
    expect(res.target).toEqual({ resource: 'networks', ids: [7] });
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `networks` declares no singleKey, so the shared PUT path is an identity unwrap:
    // the vendor's raw record is returned unchanged (nothing is silently dropped).
    stubFetch(() => json({ ...NETWORK, name: 'Renamed' }));
    const res = await makeClient().networks.update(7, { name: 'Renamed' });
    expect(res).toEqual({ ...NETWORK, name: 'Renamed' });
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    const res = await makeClient().networks.delete(7);
    expect(res).toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const res = await makeClient().networks.delete(7, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('networks.delete');
    // impact bound: a delete affects exactly one record and cannot be undone
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    const spy = stubFetch(() => json(NETWORK));
    await client.networks.get(7);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('networks.get');
    expect(audit.events[0]?.outcome).toBe('success');

    const errSpy = stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(client.networks.get(9));
    expect(errSpy.calls).toHaveLength(1);
    expect(err.correlationId).toMatch(UUID);
    expect(err.operation).toBe('networks.get');
    const last = audit.events[audit.events.length - 1] as AuditEvent;
    expect(last.outcome).toBe('error');
    expect(last.correlationId).toBe(err.correlationId);
    expect(spy.calls).toHaveLength(1);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    let call = 0;
    const spy = stubFetch(() => {
      call += 1;
      return call === 1 ? json({ ...NETWORK, updated_at: '2026-02-02T00:00:00Z' }) : json(NETWORK);
    });
    const err = await rejection(
      makeClient().networks.update(7, { name: 'x' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(StaleObjectError);
    expect(err.code).toBe('STALE_OBJECT');
    expect(err.category).toBe('conflict');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('GET');
  });

  it('issues the write when the expectedUpdatedAt revision still matches', async () => {
    const spy = stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.update(7, { name: 'x' }, { expectedUpdatedAt: NETWORK.updated_at });
    expect(res).toEqual(NETWORK);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.init.method).toBe('GET');
    expect(spy.calls[1]?.init.method).toBe('PUT');
  });

  it('refuses expectedUpdatedAt on delete with CONFIG_ERROR and issues no request', async () => {
    // registry staleCheck for networks.delete is "unavailable"; the shared delete path cannot honour the guard,
    // so it refuses instead of silently ignoring it.
    const spy = stubFetch(() => empty(204));
    const err = await rejection(makeClient().networks.delete(7, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('networks.resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.resolve({ id: 7 });
    expect(res).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().networks.resolve({ id: 999 }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the single exact match', async () => {
    const other = { ...NETWORK, id: 8, name: 'Guests', slug: 'guests' };
    const spy = stubFetch(() => json([other, NETWORK]));
    const res = await makeClient().networks.resolve('main');
    expect(res).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toContain('slug=main');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([]));
    expect(await makeClient().networks.resolve('nope')).toBeNull();
    // slug → name → address: one complete (non-paginated) read per kind, and a null
    // result is only ever returned after a COMPLETE scan.
    expect(spy.calls).toHaveLength(3);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);

    const filterSpy = stubFetch(() => json([]));
    expect(await makeClient().networks.findByAddress('10.9.9.0/24')).toBeNull();
    expect(filterSpy.calls).toHaveLength(1);
    expect(urlOf(filterSpy)).toContain('address=');
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids when several networks match', async () => {
    const first = { ...NETWORK, id: 11, name: 'Dup', slug: 'dup-1' };
    const second = { ...NETWORK, id: 12, name: 'Dup', slug: 'dup-2' };
    stubFetch(() => json([first, second]));
    const err = await rejection(makeClient().networks.resolve('Dup'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.category).toBe('resolution');
    expect(err.retryable).toBe(false);
    expect(err.resourceIds).toEqual([11, 12]);
  });

  it('returns NetworkSummary', async () => {
    stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.resolve({ id: 7 });
    expect(res).toEqual(SUMMARY);
    expect(Object.keys(res as object).sort()).toEqual(Object.keys(SUMMARY).sort());
    for (const field of DROPPED) expect(res).not.toHaveProperty(field);
  });

  it('expand: true returns the full network', async () => {
    stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.resolve({ id: 7 }, { expand: true });
    expect(res).toEqual(NETWORK);
    expect(res).toHaveProperty('description', 'a description');
    expect(res).toHaveProperty('settings', { dhcp: true });
  });

  it('returns Resolution<NetworkSummary> with resolutionDetails: true', async () => {
    stubFetch(() => json([NETWORK]));
    const res = await makeClient().networks.resolve('main', { resolutionDetails: true });
    expect(res.resolutionCost).toBe('server-filter');
    expect(res.scanTruncated).toBe(false);
    expect(res.scanned).toBe(1);
    expect(res.value).toEqual(SUMMARY);
    expect(res.candidates).toEqual([{ id: 7, label: 'Main' }]);
  });

  it('reports resolutionCost direct for the id path', async () => {
    stubFetch(() => json(NETWORK));
    const res = await makeClient().networks.resolve(7, { resolutionDetails: true });
    expect(res.resolutionCost).toBe('direct');
    expect(res.value).toEqual(SUMMARY);
  });

  it('rejects an identifier kind the vendor cannot support instead of guessing', async () => {
    const spy = stubFetch(() => json(NETWORK));
    const err = await rejection(makeClient().networks.resolve({} as NetworkIdentifier));
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toContain('id, slug, name, address');
    const emptyErr = await rejection(makeClient().networks.resolve('   '));
    expect(emptyErr).toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap is reached', async () => {
    const client = makeClient({ resolution: { maxScanRecords: 1 } });
    const a = { ...NETWORK, id: 21, name: 'A', slug: 'a' };
    const b = { ...NETWORK, id: 22, name: 'B', slug: 'b' };
    const spy = stubFetch(() => json([a, b]));
    const err = await rejection(client.networks.resolve('main'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.suggestedAction).toBeTruthy();
    // the cap shortens the response instead of pretending it is complete
    expect(spy.calls).toHaveLength(1);
  });
});

describe('networks.findByAddress', () => {
  afterEach(() => clearFetch());

  it('returns the exact CIDR match', async () => {
    const other = { ...NETWORK, id: 9, name: 'Other', address: '10.0.0.0/25' };
    const spy = stubFetch(() => json([other, NETWORK]));
    const res = await makeClient().networks.findByAddress('10.0.0.0/24');
    expect(res).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toContain('address=10.0.0.0');
  });

  it('expand: true returns the full network from findByAddress', async () => {
    stubFetch(() => json([NETWORK]));
    const res = await makeClient().networks.findByAddress('10.0.0.0/24', { expand: true });
    expect(res).toEqual(NETWORK);
  });

  it('rejects a partial server match that is not an exact CIDR', async () => {
    const partial = { ...NETWORK, id: 30, address: '10.0.0.0/16' };
    const spy = stubFetch(() => json([partial]));
    expect(await makeClient().networks.findByAddress('10.0.0.0/8')).toBeNull();
    expect(spy.calls).toHaveLength(1);
  });
});

describe('networks streaming and validation surface', () => {
  afterEach(() => clearFetch());

  it('streams the collection and yields single-page batches', async () => {
    const spy = stubFetch(() => json([NETWORK]));
    const client = makeClient();
    const streamed = [];
    for await (const item of client.networks.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages = [];
    for await (const page of client.networks.listPages()) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.hasMore).toBe(false);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);
  });

  it('returns a null-valued Resolution after a complete scan', async () => {
    stubFetch(() => json([]));
    const res = await makeClient().networks.resolve('nope', { resolutionDetails: true });
    expect(res.value).toBeNull();
    expect(res.scanTruncated).toBe(false);
    expect(res.candidates).toBeUndefined();
  });

  it('rejects an empty CIDR instead of scanning', async () => {
    const spy = stubFetch(() => json([NETWORK]));
    await expect(makeClient().networks.findByAddress('   ')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });

  it('names the accepted kinds for every unsupported identifier form', async () => {
    const spy = stubFetch(() => json(NETWORK));
    const client = makeClient();
    await expect(client.networks.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.networks.resolve({ id: 1.5 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.networks.resolve(null as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.networks.resolve([] as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.networks.resolve({ name: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.networks.resolve('   ')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('networks identifier kinds and guards', () => {
  afterEach(() => clearFetch());

  it('accepts a numeric string and the slug/name object kinds', async () => {
    const client = makeClient();
    const idSpy = stubFetch(() => json(NETWORK));
    expect(await client.networks.resolve('7')).toEqual(SUMMARY);
    expect(urlOf(idSpy)).toBe(`${BASE}/7`);

    const slugSpy = stubFetch(() => json([NETWORK]));
    expect(await client.networks.resolve({ slug: 'main' })).toEqual(SUMMARY);
    expect(urlOf(slugSpy)).toContain('slug=main');

    const nameSpy = stubFetch(() => json([NETWORK]));
    expect(await client.networks.resolve({ name: 'Main' })).toEqual(SUMMARY);
    expect(urlOf(nameSpy)).toContain('name=Main');
  });

  it('labels a candidate by its slug when the name is empty', async () => {
    const unnamed = { ...NETWORK, name: '', slug: 'main' };
    stubFetch(() => json(unnamed));
    const res = await makeClient().networks.resolve({ id: 7 }, { resolutionDetails: true });
    expect(res.candidates).toEqual([{ id: 7, label: 'main' }]);
  });
});
