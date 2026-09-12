/**
 * GroupsResource tests — primitive rows and the helper tier, against mocked envelopes.
 * `/groups` declares no envelope keys, so the records travel as bare arrays/objects.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import type { AuditEvent } from '../../src/types/common.js';
import { HuduConfigError, NotFoundError, ResolutionError, ValidationFailedError } from '../../src/errors.js';
import { stubFetch, json, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1';

function makeClient(overrides: Record<string, unknown> = {}) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...overrides });
}

/** A full group record (api-docs Group). */
function group(over: Record<string, unknown> = {}) {
  return {
    id: 4,
    name: 'Engineering',
    slug: 'engineering',
    url: 'https://hudu.example.com/groups/engineering',
    default: false,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    member_count: 12,
    members: [{ id: 1, name: 'Ada' }],
    ...over,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function auditSpy() {
  const events: AuditEvent[] = [];
  return { events, hook: (event: AuditEvent) => { events.push(event); } };
}

function listOnce(items: unknown[]) {
  let n = 0;
  return stubFetch(() => { n += 1; return json(n === 1 ? items : []); });
}

describe('GroupsResource', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped groups list', async () => {
    const spy = listOnce([group()]);
    const res = await makeClient().groups.listAll({});
    expect(res).toEqual([group()]);
    expect(spy.calls[0].url).toContain(`${BASE}/groups`);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => group({ id: i + 1 }));
    const spy = stubFetch((url) => (url.includes('page=1') ? json(page1) : json([group({ id: 99 })])));
    const res = await makeClient().groups.listAll({});
    expect(res).toHaveLength(26);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    const spy = stubFetch(() => { n += 1; return n === 1 ? json(group()) : json({ error: 'boom' }, 500); });
    await client.groups.get(4);
    expect(spy.calls).toHaveLength(1);
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    expect(audit.events[0]!.operation).toBe('groups.get');
    expect(audit.events[0]!.outcome).toBe('success');

    const err = await client.groups.get(4).then(
      () => { throw new Error('expected the request to reject'); },
      (e: { correlationId?: string }) => e,
    );
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events.at(-1)!.correlationId).toBe(err.correlationId);
    expect(audit.events.at(-1)!.outcome).toBe('error');
  });

  it('returns the unwrapped groups record', async () => {
    const spy = stubFetch(() => json(group()));
    const res = await makeClient().groups.get(4);
    expect(res).toEqual(group());
    expect(spy.calls[0].url).toBe(`${BASE}/groups/4`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'missing' }, 404));
    const err = await makeClient().groups.get(999).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as NotFoundError,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('GroupsResource helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(group()));
    const res = await makeClient().groups.resolve(4);
    expect(res).toEqual({
      id: 4, name: 'Engineering', slug: 'engineering', default: false, member_count: 12, updated_at: '2026-09-02T00:00:00Z',
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe(`${BASE}/groups/4`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'missing' }, 404));
    await expect(makeClient().groups.resolve({ id: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    // A bare slug is narrowed with the vendor `search` filter and compared exactly.
    const spy = listOnce([group({ id: 1, slug: 'other' }), group({ id: 2, slug: 'engineering' })]);
    const res = await makeClient().groups.resolve('engineering');
    expect(res).toMatchObject({ id: 2, slug: 'engineering' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('search=engineering');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json([]));
    await expect(makeClient().groups.resolve('Absent')).resolves.toBeNull();
    // Bare value: the slug pass, then the exact-name pass, both vendor-filtered.
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].url).toContain('search=Absent');
    expect(spy.calls[1].url).toContain('name=Absent');
  });

  it('returns GroupSummary', async () => {
    stubFetch(() => json([group()]));
    const summary = await makeClient().groups.resolve({ name: 'Engineering' });
    expect(Object.keys(summary as object).sort()).toEqual(
      ['default', 'id', 'member_count', 'name', 'slug', 'updated_at'],
    );
    expect(summary).not.toHaveProperty('members');
    expect(summary).not.toHaveProperty('url');
    expect(summary).not.toHaveProperty('created_at');
  });

  it('expand: true returns the full group', async () => {
    stubFetch(() => json([group()]));
    const full = await makeClient().groups.resolve({ slug: 'engineering' }, { expand: true });
    expect(full).toEqual(group());
    expect(full).toHaveProperty('members');
  });

  it('throws RESOLUTION_AMBIGUOUS when the vendor filter matches several groups', async () => {
    listOnce([group({ id: 1, slug: 'engineering' }), group({ id: 2, slug: 'engineering' })]);
    const err = await makeClient().groups.resolve({ slug: 'engineering' }).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ResolutionError,
    );
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 2]);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap stops the search', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => group({ id: i + 1, name: 'other', slug: `s${i}` }));
    const spy = stubFetch(() => json(fullPage));
    const err = await makeClient().groups.resolve('never-matches').then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ResolutionError,
    );
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(spy.calls).toHaveLength(4);
  });

  it('reports the resolution cost and candidates with resolutionDetails', async () => {
    stubFetch(() => json([group()]));
    const resolution = await makeClient().groups.resolve({ name: 'Engineering' }, { resolutionDetails: true });
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.scanned).toBe(1);
    expect(resolution.candidates).toEqual([{ id: 4, label: 'Engineering' }]);
    expect(resolution.value).toMatchObject({ id: 4, member_count: 12 });
  });

  it('refuses an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json([]));
    const err = await makeClient().groups.resolve({ external_id: 'eng' }).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ValidationFailedError,
    );
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect(err.message).toContain('accepted');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns matching GroupSummary records', async () => {
    const spy = listOnce([group({ id: 1 }), group({ id: 2 })]);
    const res = await makeClient().groups.search('eng');
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ id: 1, member_count: 12 });
    expect(res[0]).not.toHaveProperty('members');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('search=eng');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = listOnce([group({ id: 1 }), group({ id: 2 }), group({ id: 3 })]);
    const res = await makeClient().groups.search('eng', { limit: 2 });
    expect(res).toHaveLength(2);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('page_size=2');

    await expect(makeClient().groups.search('eng', { limit: 101 })).rejects.toBeInstanceOf(HuduConfigError);
    await expect(makeClient().groups.search('eng', { limit: 1.5 })).rejects.toBeInstanceOf(HuduConfigError);
  });
});

describe('GroupsResource identifier edges', () => {
  afterEach(() => clearFetch());

  it('refuses malformed identifiers instead of guessing', async () => {
    const client = makeClient();
    await expect(client.groups.resolve('')).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.groups.resolve({ id: 0 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.groups.resolve({ id: 'x' as unknown as number })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.groups.resolve({ slug: 42 as unknown as string })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.groups.resolve({ slug: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.groups.resolve({ name: 'a', slug: 'b' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.groups.resolve({})).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.groups.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('returns the resolution of the full records when both flags are set', async () => {
    stubFetch(() => json([group()]));
    const resolution = await makeClient().groups.resolve({ name: 'Engineering' }, { expand: true, resolutionDetails: true });
    expect(resolution.value).toEqual(group());
  });

  it('lists and pages without parameters', async () => {
    let n = 0;
    stubFetch(() => { n += 1; return n <= 2 ? json([group()]) : json([]); });
    const client = makeClient();
    const streamed: unknown[] = [];
    for await (const item of client.groups.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of client.groups.listPages()) pages.push(page);
    expect((pages[0] as { items: unknown[] }).items).toHaveLength(1);
  });

  it('returns null only after scanning both the slug and the name filter', async () => {
    const spy = stubFetch((url) => (url.includes('search=') ? json([]) : json([group({ id: 99, name: 'other' })])));
    await expect(makeClient().groups.resolve('never')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(2);
  });
});
