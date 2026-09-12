/**
 * ip_addresses — primitive rows and the agent-execution-layer helper tier
 * (`resolve`, `findByAddress`). Uses the shared mocked-fetch helper; never touches the
 * network. Test titles are copied verbatim from `capabilities.plan.json`.
 *
 * The vendor's `IpAddress` definition declares no `id` even though
 * `/ip_addresses/{id}` exists, so candidate labels fall back to the address.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduError, NotFoundError, ResolutionError, ValidationFailedError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { IpAddressIdentifier, IpAddressSummary } from '../../src/types/ip_address.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/ip_addresses';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fields the compact `IpAddressSummary` must drop (policy §9). */
const DROPPED: string[] = ['notes', 'skip_dns_validation'];

const IP = {
  id: 7,
  address: '10.0.0.5',
  status: 'assigned',
  fqdn: 'host.example.com',
  description: 'a description',
  notes: 'some notes',
  asset_id: 12,
  network_id: 34,
  company_id: 56,
  skip_dns_validation: false,
};

const SUMMARY: IpAddressSummary = {
  id: 7,
  address: '10.0.0.5',
  status: 'assigned',
  fqdn: 'host.example.com',
  asset_id: 12,
  network_id: 34,
  company_id: 56,
  description: 'a description',
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

describe('ip_addresses primitives', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped ip_addresses list', async () => {
    const spy = stubFetch(() => json([IP]));
    expect(await makeClient().ipAddresses.listAll()).toEqual([IP]);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(BASE);
  });

  it('never sends page/page_size to the non-paginated endpoint', async () => {
    const spy = stubFetch(() => json([IP]));
    await makeClient().ipAddresses.listAll({ page: 2, page_size: 25 });
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).not.toContain('page');
  });

  it('returns the unwrapped ip_addresses record', async () => {
    const spy = stubFetch(() => json(IP));
    expect(await makeClient().ipAddresses.get(7)).toEqual(IP);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().ipAddresses.get(7));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('returns the created ip_addresses record', async () => {
    const spy = stubFetch(() => json(IP));
    const res = await makeClient().ipAddresses.create({ address: '10.0.0.5', network_id: 34 });
    expect(res).toEqual(IP);
    expect(spy.calls[0]?.init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(IP));
    const res = await makeClient().ipAddresses.create({ address: '10.0.0.5' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('ip_addresses.create');
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('returns the updated ip_addresses record', async () => {
    const spy = stubFetch(() => json({ ...IP, status: 'reserved' }));
    expect(await makeClient().ipAddresses.update(7, { status: 'reserved' })).toEqual({ ...IP, status: 'reserved' });
    expect(spy.calls[0]?.init.method).toBe('PUT');
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(IP));
    const res = await makeClient().ipAddresses.update(7, { status: 'reserved' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('ip_addresses.update');
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('ignores expectedUpdatedAt because the record declares no revision field', async () => {
    // staleCheck is "unavailable" for ip_addresses.update: no read, just the PUT.
    const spy = stubFetch(() => json({ ...IP, status: 'reserved' }));
    expect(await makeClient().ipAddresses.update(7, { status: 'reserved' }, { expectedUpdatedAt: 'any' })).toEqual({
      ...IP,
      status: 'reserved',
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('PUT');
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `ip_addresses` declares no singleKey: the shared PUT path is an identity unwrap.
    stubFetch(() => json({ ...IP, status: 'reserved' }));
    expect(await makeClient().ipAddresses.update(7, { status: 'reserved' })).toEqual({ ...IP, status: 'reserved' });
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    expect(await makeClient().ipAddresses.delete(7)).toBeUndefined();
    expect(spy.calls[0]?.init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const res = await makeClient().ipAddresses.delete(7, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(res.simulated).toBe(true);
    expect(res.operation).toBe('ip_addresses.delete');
    expect(res.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    stubFetch(() => json(IP));
    await client.ipAddresses.get(7);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    const errSpy = stubFetch(() => json({ error: 'nope' }, 404));
    const err = await rejection(client.ipAddresses.get(9));
    expect(errSpy.calls).toHaveLength(1);
    expect(err.correlationId).toMatch(UUID);
    const last = audit.events[audit.events.length - 1] as AuditEvent;
    expect(last.outcome).toBe('error');
    expect(last.correlationId).toBe(err.correlationId);
  });
});

describe('ip_addresses.resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(IP));
    expect(await makeClient().ipAddresses.resolve({ id: 7 })).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().ipAddresses.resolve({ id: 999 }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the single exact match', async () => {
    const other = { ...IP, id: 8, address: '10.0.0.6', fqdn: 'other.example.com' };
    const spy = stubFetch(() => json([other, IP]));
    expect(await makeClient().ipAddresses.resolve('10.0.0.5')).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toContain('address=10.0.0.5');
  });

  it('falls back from the address kind to the FQDN kind', async () => {
    const spy = stubFetch(() => json([IP]));
    const res = await makeClient().ipAddresses.resolve('host.example.com');
    expect(res).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(2);
    expect(urlOf(spy)).toContain('address=host.example.com');
    expect(urlOf(spy, 1)).toContain('fqdn=host.example.com');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([]));
    expect(await makeClient().ipAddresses.resolve('nope')).toBeNull();
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);

    const filterSpy = stubFetch(() => json([]));
    expect(await makeClient().ipAddresses.findByAddress('10.9.9.9')).toBeNull();
    expect(filterSpy.calls).toHaveLength(1);
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids', async () => {
    const first = { ...IP, id: 11, address: '10.0.0.9', fqdn: 'dup.example.com' };
    const second = { ...IP, id: 12, address: '10.0.0.9', fqdn: 'dup.example.com' };
    stubFetch(() => json([first, second]));
    const err = await rejection(makeClient().ipAddresses.resolve('10.0.0.9'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([11, 12]);
  });

  it('labels a candidate by its address when the record carries no id', async () => {
    // The vendor definition does not guarantee an `id`; the label falls back to the
    // address and no id is invented for the candidate list.
    const withoutId = { ...IP };
    delete (withoutId as { id?: number }).id;
    const other = { ...withoutId, address: '10.0.0.5' };
    stubFetch(() => json([withoutId, other]));
    const err = await rejection(makeClient().ipAddresses.resolve({ address: '10.0.0.5' }));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
  });

  it('returns IpAddressSummary', async () => {
    stubFetch(() => json(IP));
    const res = await makeClient().ipAddresses.resolve({ id: 7 });
    expect(res).toEqual(SUMMARY);
    expect(Object.keys(res as object).sort()).toEqual(Object.keys(SUMMARY).sort());
    for (const field of DROPPED) expect(res).not.toHaveProperty(field);
  });

  it('expand: true returns the full record', async () => {
    stubFetch(() => json(IP));
    const res = await makeClient().ipAddresses.resolve({ id: 7 }, { expand: true });
    expect(res).toEqual(IP);
    expect(res).toHaveProperty('skip_dns_validation', false);
  });

  it('rejects an identifier kind the vendor cannot support instead of guessing', async () => {
    const spy = stubFetch(() => json(IP));
    const err = await rejection(makeClient().ipAddresses.resolve({ network_id: 34 } as IpAddressIdentifier));
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect(err.message).toContain('id, exact address, exact FQDN');
    expect(spy.calls).toHaveLength(0);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap is reached', async () => {
    const client = makeClient({ resolution: { maxScanRecords: 1 } });
    const a = { ...IP, id: 21, address: '10.0.0.21' };
    const b = { ...IP, id: 22, address: '10.0.0.22' };
    stubFetch(() => json([a, b]));
    const err = await rejection(client.ipAddresses.resolve('10.0.0.5'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
  });
});

describe('ip_addresses.findByAddress', () => {
  afterEach(() => clearFetch());

  it('returns the exact match', async () => {
    const other = { ...IP, id: 8, address: '10.0.0.6' };
    const spy = stubFetch(() => json([other, IP]));
    expect(await makeClient().ipAddresses.findByAddress('10.0.0.5')).toEqual(SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(urlOf(spy)).toContain('address=10.0.0.5');
  });

  it('returns the full record with expand: true', async () => {
    stubFetch(() => json([IP]));
    expect(await makeClient().ipAddresses.findByAddress('10.0.0.5', { expand: true })).toEqual(IP);
  });
});

describe('ip_addresses streaming and validation surface', () => {
  afterEach(() => clearFetch());

  it('streams the collection and yields single-page batches', async () => {
    const spy = stubFetch(() => json([IP]));
    const client = makeClient();
    const streamed = [];
    for await (const item of client.ipAddresses.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages = [];
    for await (const page of client.ipAddresses.listPages()) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.hasMore).toBe(false);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => !call.url.includes('page'))).toBe(true);
  });

  it('returns a null-valued Resolution after a complete scan', async () => {
    stubFetch(() => json([]));
    const res = await makeClient().ipAddresses.resolve('nope', { resolutionDetails: true });
    expect(res.value).toBeNull();
    expect(res.scanTruncated).toBe(false);
    expect(res.candidates).toBeUndefined();
  });

  it('rejects an empty address instead of scanning', async () => {
    const spy = stubFetch(() => json([IP]));
    await expect(makeClient().ipAddresses.findByAddress('   ')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });

  it('names the accepted kinds for every unsupported identifier form', async () => {
    const spy = stubFetch(() => json(IP));
    const client = makeClient();
    await expect(client.ipAddresses.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.ipAddresses.resolve({ id: 1.5 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.ipAddresses.resolve(null as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.ipAddresses.resolve([] as unknown as number)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.ipAddresses.resolve({ address: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.ipAddresses.resolve({ fqdn: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.ipAddresses.resolve('   ')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('ip_addresses identifier kinds and resolution details', () => {
  afterEach(() => clearFetch());

  it('returns Resolution<IpAddressSummary> with candidates', async () => {
    stubFetch(() => json(IP));
    const res = await makeClient().ipAddresses.resolve({ id: 7 }, { resolutionDetails: true });
    expect(res.value).toEqual(SUMMARY);
    expect(res.resolutionCost).toBe('direct');
    expect(res.candidates).toEqual([{ id: 7, label: '10.0.0.5' }]);
  });

  it('returns Resolution<IpAddress> with expand: true', async () => {
    stubFetch(() => json(IP));
    const res = await makeClient().ipAddresses.resolve({ id: 7 }, { expand: true, resolutionDetails: true });
    expect(res.value).toEqual(IP);
  });

  it('accepts a numeric string as an id', async () => {
    const spy = stubFetch(() => json(IP));
    expect(await makeClient().ipAddresses.resolve('7')).toEqual(SUMMARY);
    expect(urlOf(spy)).toBe(`${BASE}/7`);
  });

  it('labels a candidate by its FQDN when the address is empty', async () => {
    const nameless = { ...IP, address: '' };
    stubFetch(() => json(nameless));
    const res = await makeClient().ipAddresses.resolve({ id: 7 }, { resolutionDetails: true });
    expect(res.candidates).toEqual([{ id: 7, label: 'host.example.com' }]);
  });
});
