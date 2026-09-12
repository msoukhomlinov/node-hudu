/**
 * WebsitesResource tests — primitive rows and the helper tier, all against mocked
 * fetch envelopes. Never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import type { AuditEvent } from '../../src/types/common.js';
import { HuduConfigError, NotFoundError, ResolutionError, ValidationFailedError } from '../../src/errors.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1';

function makeClient(overrides: Record<string, unknown> = {}) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...overrides });
}

/** A full website record (api-docs Website). */
function website(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'https://acme.example.com',
    slug: 'acme',
    code: 200,
    message: 'OK',
    keyword: 'acme',
    monitor_type: 1,
    status: 'ready',
    monitoring_status: 'up',
    refreshed_at: '2026-09-01T00:00:00Z',
    monitored_at: '2026-09-01T00:00:00Z',
    headers: { server: 'nginx' },
    paused: false,
    sent_notifications: false,
    account_id: 3,
    asset_field_id: 4,
    company_id: 42,
    company_name: 'Acme',
    discarded_at: '',
    disable_ssl: false,
    disable_whois: false,
    disable_dns: false,
    enable_dmarc_tracking: false,
    enable_dkim_tracking: false,
    enable_spf_tracking: false,
    notes: 'internal notes',
    object_type: 'Website',
    icon: 'fa-globe',
    asset_type: 'Website',
    archived: false,
    url: 'https://hudu.example.com/websites/acme',
    updated_at: '2026-09-02T00:00:00Z',
    ...over,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function auditSpy() {
  const events: AuditEvent[] = [];
  return { events, hook: (event: AuditEvent) => { events.push(event); } };
}

/** A stub that answers a vendor-filtered list with `items` and exhausts on the next page. */
function listOnce(items: unknown[]) {
  let n = 0;
  return stubFetch(() => { n += 1; return json(n === 1 ? items : []); });
}

describe('WebsitesResource', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped websites list', async () => {
    const spy = listOnce([website()]);
    const res = await makeClient().websites.listAll({});
    expect(res).toEqual([website()]);
    expect(spy.calls[0].url).toContain(`${BASE}/websites`);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => website({ id: i + 1 }));
    const spy = stubFetch((url) => (url.includes('page=1') ? json(page1) : json([website({ id: 99 })])));
    const res = await makeClient().websites.listAll({});
    expect(res).toHaveLength(26);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
    expect(spy.calls[1].url).toContain('page=2');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    const spy = stubFetch(() => { n += 1; return n === 1 ? json(website()) : json({ error: 'boom' }, 500); });
    await client.websites.get(7);
    expect(spy.calls).toHaveLength(1);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    expect(audit.events[0]!.operation).toBe('websites.get');
    expect(audit.events[0]!.outcome).toBe('success');

    // Error path: the thrown error carries the same id the audit event reported.
    const err = await client.websites.delete(7).then(
      () => { throw new Error('expected the request to reject'); },
      (e: { correlationId?: string }) => e,
    );
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events.at(-1)!.correlationId).toBe(err.correlationId);
    expect(audit.events.at(-1)!.outcome).toBe('error');
  });

  it('returns the unwrapped websites record', async () => {
    const spy = stubFetch(() => json(website()));
    const res = await makeClient().websites.get(7);
    expect(res).toEqual(website());
    expect(spy.calls[0].url).toBe(`${BASE}/websites/7`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await makeClient().websites.get(999).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as NotFoundError,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('returns the created websites record', async () => {
    const spy = stubFetch(() => json(website(), 201));
    const res = await makeClient().websites.create({ name: 'https://acme.example.com' });
    expect(res).toEqual(website());
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].url).toBe(`${BASE}/websites`);
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ website: { name: 'https://acme.example.com' } }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().websites.create({ name: 'https://acme.example.com' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.wouldApply).toBe(true);
    expect(result.request).toEqual({ method: 'POST', path: '/websites' });
    expect(result.target.resource).toBe('websites');
  });

  it('returns the updated websites record', async () => {
    const spy = stubFetch(() => json(website({ name: 'https://new.example.com' })));
    const res = await makeClient().websites.update(7, { name: 'https://new.example.com' });
    expect(res).toEqual(website({ name: 'https://new.example.com' }));
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].url).toBe(`${BASE}/websites/7`);
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().websites.update(7, { paused: true }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'PUT', path: '/websites/7' });
    expect(result.target.ids).toEqual([7]);
  });

  it('unwraps the PUT response by singleKey', async () => {
    // `/websites` declares NO singleKey, so the PUT body is passed through unchanged
    // (the unwrap is a documented pass-through rather than an invented envelope).
    const enveloped = { website: website() };
    stubFetch(() => json(enveloped));
    const res = await makeClient().websites.update(7, { paused: true });
    expect(res).toEqual(enveloped);
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().websites.delete(7)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[0].url).toBe(`${BASE}/websites/7`);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().websites.delete(7, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'DELETE', path: '/websites/7' });
    expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    // update: updateOne reads the current record, compares updated_at, then PUTs.
    const stale = stubFetch(() => json(website({ updated_at: '2026-09-02T00:00:00Z' })));
    await expect(
      makeClient().websites.update(7, { paused: true }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'STALE_OBJECT', category: 'conflict' });
    expect(stale.calls).toHaveLength(1);
    expect(stale.calls[0].init.method).toBe('GET');
    clearFetch();

    // A matching revision lets the guarded update through.
    const ok = stubFetch(() => json(website({ updated_at: '2026-09-02T00:00:00Z' })));
    const updated = await makeClient().websites.update(7, { paused: true }, { expectedUpdatedAt: '2026-09-02T00:00:00Z' });
    expect(updated).toEqual(website());
    expect(ok.calls.map((call) => call.init.method)).toEqual(['GET', 'PUT']);
  });
});

describe('WebsitesResource helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(website()));
    const res = await makeClient().websites.resolve(7);
    expect(res).toEqual({ id: 7, name: 'https://acme.example.com', company_id: 42, monitoring_status: 'up', paused: false, archived: false });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe(`${BASE}/websites/7`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'nope' }, 404));
    await expect(makeClient().websites.resolve({ id: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    const spy = listOnce([website({ id: 1, slug: 'other' }), website({ id: 2, slug: 'acme' })]);
    const res = await makeClient().websites.resolve('acme');
    expect(res).toMatchObject({ id: 2, name: 'https://acme.example.com' });
    expect(spy.calls[0].url).toContain('slug=acme');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([]));
    const res = await makeClient().websites.resolve('missing.example.com');
    expect(res).toBeNull();
    // Bare value: the slug pass, then the exact-name pass, both vendor-filtered.
    expect(spy.calls.map((call) => call.url)).toEqual([
      expect.stringContaining('slug=missing.example.com'),
      expect.stringContaining('name=missing.example.com'),
    ]);
  });

  it('returns WebsiteSummary', async () => {
    stubFetch(() => json([website()]));
    const summary = await makeClient().websites.resolve({ name: 'https://acme.example.com' });
    expect(summary).not.toBeNull();
    // Kept: the identifier fields and the monitoring state an agent needs.
    expect(Object.keys(summary as object).sort()).toEqual(
      ['archived', 'company_id', 'id', 'monitoring_status', 'name', 'paused'],
    );
    // Dropped: the full record's bulk (headers, notes, account_id, and so on).
    for (const dropped of ['headers', 'notes', 'account_id', 'code', 'message', 'keyword', 'url']) {
      expect(summary as object).not.toHaveProperty(dropped);
    }
  });

  it('expand: true returns the full website', async () => {
    const spy = stubFetch(() => json([website()]));
    const full = await makeClient().websites.resolve({ slug: 'acme' }, { expand: true });
    expect(full).toEqual(website());
    expect(full).toHaveProperty('headers');
    expect(full).toHaveProperty('notes', 'internal notes');
    expect(spy.calls).toHaveLength(1);
  });

  it('throws RESOLUTION_AMBIGUOUS when the vendor filter matches several records', async () => {
    listOnce([website({ id: 1, slug: 'acme' }), website({ id: 2, slug: 'acme' })]);
    const err = await makeClient().websites.resolve({ slug: 'acme' }).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ResolutionError,
    );
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 2]);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap stops the search', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => website({ id: i + 1, slug: `s${i}` }));
    const spy = stubFetch(() => json(fullPage));
    const err = await makeClient().websites.resolve('never-matches').then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ResolutionError,
    );
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    // Bounded: 4 pages of 25 (the client cap), never an unbounded scan.
    expect(spy.calls).toHaveLength(4);
  });

  it('reports the resolution cost and candidates with resolutionDetails', async () => {
    stubFetch(() => json([website()]));
    const resolution = await makeClient().websites.resolve({ slug: 'acme' }, { resolutionDetails: true });
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.scanned).toBe(1);
    expect(resolution.candidates).toEqual([{ id: 7, label: 'https://acme.example.com' }]);
    expect(resolution.value).toMatchObject({ id: 7 });
  });

  it('refuses an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json([]));
    const err = await makeClient().websites.resolve({ domain: 'acme.example.com' }).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ValidationFailedError,
    );
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toContain('accepted');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns the exact match', async () => {
    listOnce([website({ id: 3, slug: 'exact' })]);
    const res = await makeClient().websites.findBySlug('exact');
    expect(res).toMatchObject({ id: 3 });
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([]));
    await expect(makeClient().websites.findBySlug('absent')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('returns WebsiteSummary', async () => {
    stubFetch(() => json([website({ slug: 'acme' })]));
    const summary = await makeClient().websites.findBySlug('acme');
    expect(summary).toEqual({
      id: 7, name: 'https://acme.example.com', company_id: 42, monitoring_status: 'up', paused: false, archived: false,
    });
    expect(summary).not.toHaveProperty('headers');
  });

  it('returns matching WebsiteSummary records', async () => {
    const spy = listOnce([website({ id: 1 }), website({ id: 2 })]);
    const res = await makeClient().websites.search('acme');
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ id: 1 });
    expect(res[0]).not.toHaveProperty('headers');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('search=acme');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = listOnce([website({ id: 1 }), website({ id: 2 }), website({ id: 3 })]);
    const res = await makeClient().websites.search('acme', { limit: 2 });
    expect(res).toHaveLength(2);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('page_size=2');

    // Above the hard maximum the SDK refuses (never silently clamps).
    await expect(makeClient().websites.search('acme', { limit: 101 })).rejects.toBeInstanceOf(HuduConfigError);
    await expect(makeClient().websites.search('acme', { limit: 0 })).rejects.toBeInstanceOf(HuduConfigError);
  });
});

describe('WebsitesResource identifier and guard edges', () => {
  afterEach(() => clearFetch());

  it('refuses malformed identifiers instead of guessing', async () => {
    const client = makeClient();
    await expect(client.websites.resolve('')).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.websites.resolve(-1)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.websites.resolve(1.5)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.websites.resolve({ id: 0 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.websites.resolve({ id: 'x' as unknown as number })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.websites.resolve({ slug: 42 as unknown as string })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.websites.resolve({ slug: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.websites.resolve({ name: 'a', slug: 'b' })).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('returns the resolution of the full records when both flags are set', async () => {
    stubFetch(() => json([website()]));
    const resolution = await makeClient().websites.resolve({ slug: 'acme' }, { expand: true, resolutionDetails: true });
    expect(resolution.value).toEqual(website());
    expect(resolution.resolutionCost).toBe('server-filter');
  });

  it('lists and pages without parameters', async () => {
    let n = 0;
    stubFetch(() => { n += 1; return n <= 2 ? json([website()]) : json([]); });
    const client = makeClient();
    const streamed: unknown[] = [];
    for await (const item of client.websites.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of client.websites.listPages()) pages.push(page);
    expect((pages[0] as { items: unknown[] }).items).toHaveLength(1);
  });

  it('returns null only after scanning both the slug and the name filter', async () => {
    // The slug pass is empty; the name pass returns a non-matching record — the scan
    // still decides "nothing found" because it examined the whole page.
    const spy = stubFetch((url) => (url.includes('slug=') ? json([]) : json([website({ id: 99, name: 'other' })])));
    await expect(makeClient().websites.resolve('never.example.com')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(2);
  });

  it('refuses the expectedUpdatedAt guard on create and delete', async () => {
    // Plan `staleCheck: unavailable` on create/delete: the guard compares an existing
    // revision, so it is refused there rather than silently ignored.
    const spy = stubFetch(() => json({}));
    const client = makeClient();
    await expect(
      client.websites.create({ slug: 'acme' }, { expectedUpdatedAt: '2026-09-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(HuduConfigError);
    await expect(
      client.websites.delete(7, { expectedUpdatedAt: '2026-09-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});
