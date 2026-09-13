/**
 * rack_storages — primitive rows and the agent-execution-layer helper tier
 * (`resolve` by id or exact name). Uses the shared mocked-fetch helper; never touches
 * the network. Test titles are copied verbatim from `capabilities.plan.json`.
 *
 * Hudu declares no `name` filter on `/rack_storages`, so the name kind is a bounded
 * client scan over the non-paginated collection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError, NotFoundError, ResolutionError, StaleObjectError, ValidationFailedError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { RackStorageIdentifier, RackStorageSummary } from '../../src/types/rack_storage.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/rack_storages';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fields the compact `RackStorageSummary` must drop (policy §9). */
const DROPPED: string[] = ['description', 'created_at', 'discarded_at'];

const RACK = {
  id: 7,
  location_id: 4,
  name: 'Main rack',
  description: 'a description',
  max_wattage: 5000,
  starting_unit: 1,
  height: 42,
  width: 24,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  discarded_at: null,
  company_id: 3,
};

const SUMMARY: RackStorageSummary = {
  id: 7,
  name: 'Main rack',
  company_id: 3,
  location_id: 4,
  height: 42,
  width: 24,
  max_wattage: 5000,
  starting_unit: 1,
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

describe('rack_storages primitives', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped rack_storages list', async () => {
    const spy = stubFetch(() => json([RACK]));
    expect(await makeClient().rackStorages.listAll()).toEqual([RACK]);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(BASE);
  });

  it('never sends page/page_size to the non-paginated endpoint', async () => {
    const spy = stubFetch(() => json([RACK]));
    await makeClient().rackStorages.listAll({ page: 2, page_size: 10 });
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).not.toContain('page');
  });

  it('returns the unwrapped rack_storages record', async () => {
    const spy = stubFetch(() => json(RACK));
    expect(await makeClient().rackStorages.get(7)).toEqual(RACK);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().rackStorages.get(7));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('returns the created rack_storages record', async () => {
    const spy = stubFetch(() => json(RACK));
    const res = await makeClient().rackStorages.create({ name: 'Main rack', height: 42 });
    expect(res).toEqual(RACK);
    expect(spy.calls[0]?.init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(RACK));
    const res = await makeClient().rackStorages.create({ name: 'Main rack' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('rack_storages.create');
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('returns the updated rack_storages record', async () => {
    const spy = stubFetch(() => json({ ...RACK, name: 'Renamed' }));
    expect(await makeClient().rackStorages.update(7, { name: 'Renamed' })).toEqual({ ...RACK, name: 'Renamed' });
    expect(spy.calls[0]?.init.method).toBe('PUT');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(RACK));
    const res = await makeClient().rackStorages.update(7, { name: 'x' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('rack_storages.update');
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `rack_storages` declares no singleKey: the shared PUT path is an identity unwrap.
    stubFetch(() => json({ ...RACK, name: 'Renamed' }));
    expect(await makeClient().rackStorages.update(7, { name: 'Renamed' })).toEqual({ ...RACK, name: 'Renamed' });
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    expect(await makeClient().rackStorages.delete(7)).toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const res = await makeClient().rackStorages.delete(7, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('rack_storages.delete');
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    stubFetch(() => json(RACK));
    await client.rackStorages.get(7);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    const errSpy = stubFetch(() => json({ error: 'nope' }, 404));
    const err = await rejection(client.rackStorages.get(9));
    expect(errSpy.calls).toHaveLength(1);
    expect(err.correlationId).toMatch(UUID);
    const last = audit.events[audit.events.length - 1] as AuditEvent;
    expect(last.outcome).toBe('error');
    expect(last.correlationId).toBe(err.correlationId);
  });

  it('refuses expectedUpdatedAt on update with CONFIG_ERROR and issues no request', async () => {
    // Live-verified on Hudu 2.45.1 (2026-09-12): GET /rack_storages (and the create/update
    // responses) carry NO created_at/updated_at, so no revision exists to compare, this row's
    // staleCheck is "unavailable", and STALE_OBJECT is UNREACHABLE — the registry no longer
    // advertises it and the SDK refuses the guard by name before any request.
    const spy = stubFetch(() => json({ ...RACK, updated_at: '2026-02-02T00:00:00Z' }));
    const err = await rejection(
      makeClient().rackStorages.update(7, { name: 'x' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(spy.calls).toHaveLength(0);
  });

  it('types created_at/updated_at as optional because the live record never carries them', async () => {
    // Live-verified fact mirrored with a fixture: the vendor sends neither timestamp, so a
    // record without them still satisfies the declared `RackStorage` type.
    const live = { ...RACK, created_at: undefined, updated_at: undefined, discarded_at: undefined };
    const spy = stubFetch(() => json(live));
    const record = await makeClient().rackStorages.get(7);
    expect(record.updated_at).toBeUndefined();
    expect(record.created_at).toBeUndefined();
    expect(spy.calls).toHaveLength(1);
  });

  it('refuses expectedUpdatedAt on delete with CONFIG_ERROR and issues no request', async () => {
    // registry staleCheck for rack_storages.delete is "unavailable"; the shared delete path cannot honour the guard,
    // so it refuses instead of silently ignoring it.
    const spy = stubFetch(() => empty(204));
    const err = await rejection(makeClient().rackStorages.delete(7, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(spy.calls).toHaveLength(0);
  });

  it('issues the write when no expectedUpdatedAt guard is passed', async () => {
    const spy = stubFetch(() => json(RACK));
    expect(await makeClient().rackStorages.update(7, { name: 'x' })).toEqual(RACK);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('PUT');
  });
});

describe('rack_storages.resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(RACK));
    expect(await makeClient().rackStorages.resolve({ id: 7 })).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().rackStorages.resolve({ id: 999 }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the single exact match', async () => {
    const other = { ...RACK, id: 8, name: 'Spare rack' };
    const spy = stubFetch(() => json([other, RACK]));
    const res = await makeClient().rackStorages.resolve('Main rack', { resolutionDetails: true });
    expect(res.value).toEqual(SUMMARY);
    // no vendor name filter exists: one complete (non-paginated) collection read
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(BASE);
    expect(res.resolutionCost).toBe('client-scan');
    expect(res.candidates).toEqual([{ id: 7, label: 'Main rack' }]);
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([RACK]));
    expect(await makeClient().rackStorages.resolve('nope')).toBeNull();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);
  });

  it('throws RESOLUTION_AMBIGUOUS when several racks share a name', async () => {
    const first = { ...RACK, id: 11, name: 'Dup' };
    const second = { ...RACK, id: 12, name: 'Dup' };
    stubFetch(() => json([first, second]));
    const err = await rejection(makeClient().rackStorages.resolve('Dup'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([11, 12]);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap is reached', async () => {
    const client = makeClient({ resolution: { maxScanRecords: 1 } });
    const a = { ...RACK, id: 21, name: 'A' };
    const b = { ...RACK, id: 22, name: 'B' };
    const spy = stubFetch(() => json([a, b]));
    const err = await rejection(client.rackStorages.resolve('Main rack'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.retryable).toBe(false);
    expect(spy.calls).toHaveLength(1);
  });

  it('rejects an identifier kind the vendor cannot support instead of guessing', async () => {
    const spy = stubFetch(() => json(RACK));
    const err = await rejection(makeClient().rackStorages.resolve({ slug: 'main' } as RackStorageIdentifier));
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect(err.message).toContain('id, exact name');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns RackStorageSummary', async () => {
    stubFetch(() => json(RACK));
    const res = await makeClient().rackStorages.resolve({ id: 7 });
    expect(res).toEqual(SUMMARY);
    expect(Object.keys(res as object).sort()).toEqual(Object.keys(SUMMARY).sort());
    for (const field of DROPPED) expect(res).not.toHaveProperty(field);
  });

  it('expand: true returns the full rack storage', async () => {
    stubFetch(() => json(RACK));
    const res = await makeClient().rackStorages.resolve({ id: 7 }, { expand: true });
    expect(res).toEqual(RACK);
    expect(res).toHaveProperty('discarded_at', null);
  });

  it('accepts a bare numeric id and a bare name', async () => {
    const idSpy = stubFetch(() => json(RACK));
    expect(await makeClient().rackStorages.resolve(7)).toEqual(SUMMARY);
    expect(urlOf(idSpy)).toBe(`${BASE}/7`);
    const nameSpy = stubFetch(() => json([RACK]));
    expect(await makeClient().rackStorages.resolve('Main rack')).toEqual(SUMMARY);
    expect(nameSpy.calls).toHaveLength(1);
  });
});

describe('rack_storages streaming and validation surface', () => {
  afterEach(() => clearFetch());

  it('streams the collection and yields single-page batches', async () => {
    const spy = stubFetch(() => json([RACK]));
    const client = makeClient();
    const streamed = [];
    for await (const item of client.rackStorages.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages = [];
    for await (const page of client.rackStorages.listPages()) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.hasMore).toBe(false);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);
  });

  it('returns a null-valued Resolution after a complete scan', async () => {
    stubFetch(() => json([]));
    const res = await makeClient().rackStorages.resolve('nope', { resolutionDetails: true });
    expect(res.value).toBeNull();
    expect(res.scanTruncated).toBe(false);
    expect(res.candidates).toBeUndefined();
  });

  it('names the accepted kinds for every unsupported identifier form', async () => {
    const spy = stubFetch(() => json(RACK));
    const client = makeClient();
    await expect(client.rackStorages.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.rackStorages.resolve({ id: 1.5 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.rackStorages.resolve(null as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.rackStorages.resolve([] as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.rackStorages.resolve({ name: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.rackStorages.resolve('   ')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('rack_storages identifier kinds and the scan cap', () => {
  afterEach(() => clearFetch());

  it('accepts a numeric string as an id', async () => {
    const spy = stubFetch(() => json(RACK));
    expect(await makeClient().rackStorages.resolve('7')).toEqual(SUMMARY);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('refuses to return a match found inside a truncated scan', async () => {
    const client = makeClient({ resolution: { maxScanRecords: 1 } });
    const other = { ...RACK, id: 22, name: 'B' };
    stubFetch(() => json([RACK, other]));
    const err = await rejection(client.rackStorages.resolve('Main rack'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.resourceIds).toEqual([7]);
  });

  it('labels a candidate by its name', async () => {
    const unnamed = { ...RACK, name: '' };
    stubFetch(() => json(unnamed));
    const res = await makeClient().rackStorages.resolve({ id: 7 }, { resolutionDetails: true });
    expect(res.candidates).toEqual([{ id: 7, label: '7' }]);
  });
});
