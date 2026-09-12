/**
 * Cross-resource operations tests for `searchAcrossResources` and `resolveAny`.
 *
 * Mocked global fetch only — this file never touches the network. The stubs serve one distinctive
 * row per resource, so a hit's `resource`, `id` and `label` can be asserted without re-deriving the
 * resource's own projection, and every request URL is asserted to belong to a helper-tier endpoint.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { HuduClient } from '../src/client.js';
import { Operations } from '../src/operations/index.js';
import type { SearchableResource } from '../src/operations/index.js';
import { ResolutionError } from '../src/errors.js';
import type { Identifier } from '../src/types/common.js';
import { stubFetch, json, clearFetch, type FetchHandler, type FetchSpy } from './helpers.js';

const BASE = 'https://hudu.example.com/api/v1';

/** The searchable resources in the fan-out order the helper documents. */
const SUPPORTED: SearchableResource[] = [
  'companies', 'articles', 'assets', 'websites', 'asset_passwords', 'password_folders', 'groups', 'users',
];

/** The list path of each searchable resource, as its own helper requests it. */
const RESOURCE_PATHS: Record<SearchableResource, string> = {
  companies: BASE + '/companies',
  articles: BASE + '/articles',
  assets: BASE + '/assets',
  websites: BASE + '/websites',
  asset_passwords: BASE + '/asset_passwords',
  password_folders: BASE + '/password_folders',
  groups: BASE + '/groups',
  users: BASE + '/users',
};

/** One distinctive row per resource: a company with a domain, an asset with that domain as serial, etc. */
const ROW: Record<SearchableResource, Record<string, unknown>> = {
  companies: { id: 11, name: 'Acme', slug: 'acme', website: 'https://acme.com', created_at: '2020-01-01' },
  articles: { id: 12, name: 'Acme onboarding', slug: 'acme-onboarding', created_at: '2020-01-01' },
  assets: { id: 13, name: 'Acme gateway', slug: 'acme-gateway', primary_serial: 'acme.com', created_at: '2020-01-01' },
  websites: { id: 14, name: 'acme.com', slug: 'acme', created_at: '2020-01-01' },
  asset_passwords: { id: 15, name: 'Acme admin', slug: 'acme-admin', username: 'admin', created_at: '2020-01-01' },
  password_folders: { id: 16, name: 'Acme vault', slug: 'acme-vault', created_at: '2020-01-01' },
  groups: { id: 17, name: 'Acme team', slug: 'acme-team', created_at: '2020-01-01' },
  users: { id: 18, email: 'acme@example.com', slug: 'acme', first_name: 'Acme', created_at: '2020-01-01' },
};

/** The resource whose list path this URL belongs to, or undefined for an unexpected URL. */
function ownerOf(url: string): SearchableResource | undefined {
  return SUPPORTED.find((resource) => url.includes(RESOURCE_PATHS[resource]));
}

/** The rows one resource serves, given the request URL. */
type RowsFor = (resource: SearchableResource, url: string) => unknown[];

/** Route each mocked request to the rows its resource serves. */
function route(rowsFor: RowsFor): FetchHandler {
  return (url) => {
    const resource = ownerOf(url);
    if (resource === undefined) return json({ error: 'unexpected request: ' + url }, 500);
    return json(rowsFor(resource, url));
  };
}

/** Install the stub: by default every resource serves its one distinctive row. */
function stubRows(rowsFor: RowsFor = (resource) => [ROW[resource]]): FetchSpy {
  return stubFetch(route(rowsFor));
}

function makeClient(concurrency?: number): HuduClient {
  return new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    ...(concurrency === undefined ? {} : { concurrency }),
  });
}

function makeOps(concurrency?: number): Operations {
  return new Operations(makeClient(concurrency));
}

/** Repeated rows a bounded scan never matches, used to force a truncated scan. */
function otherRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ id: 100 + i, name: 'other-' + i, slug: 'other-' + i }));
}

describe('operations.searchAcrossResources', () => {
  afterEach(() => clearFetch());

  it('returns hits from every searched resource', async () => {
    const spy = stubRows();
    const hits = await makeOps().searchAcrossResources('acme');
    expect(hits.map((hit) => hit.resource)).toEqual(SUPPORTED);
    expect(hits).toHaveLength(SUPPORTED.length);
    for (const hit of hits) {
      expect(hit.id).toBe(ROW[hit.resource].id);
      expect(hit.label.length).toBeGreaterThan(0);
    }
    // One bounded request per resource: the helper tier issues a single search page, never a walk.
    expect(spy.calls).toHaveLength(SUPPORTED.length);
    expect(spy.calls.every((call) => call.url.includes('search=acme'))).toBe(true);
    expect(spy.calls.every((call) => call.url.includes('page_size=25'))).toBe(true);
  });

  it('searches only the resources asked for', async () => {
    const spy = stubRows();
    const hits = await makeOps().searchAcrossResources('acme', { resources: ['companies', 'users'] });
    expect(hits.map((hit) => hit.resource)).toEqual(['companies', 'users']);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].url).toContain(RESOURCE_PATHS.companies);
    expect(spy.calls[1].url).toContain(RESOURCE_PATHS.users);
  });

  it('honours limit and never exceeds the maximum of 100', async () => {
    const ten = (): Array<Record<string, unknown>> => otherRows(10);
    const spy = stubRows(ten);
    const hits = await makeOps().searchAcrossResources('acme', { limit: 5 });
    expect(hits).toHaveLength(SUPPORTED.length * 5);
    expect(spy.calls.every((call) => call.url.includes('page_size=5'))).toBe(true);
    // The boundary value is accepted, and nothing is clamped silently above it.
    await expect(makeOps().searchAcrossResources('acme', { limit: 100 })).resolves.toHaveLength(SUPPORTED.length * 10);
    const rejected = await makeOps().searchAcrossResources('acme', { limit: 101 }).then(
      () => { throw new Error('expected the call to reject'); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(rejected.code).toBe('CONFIG_ERROR');
    expect(rejected.message).toContain('100');
    expect(spy.calls.filter((call) => call.url.includes('page_size=101'))).toHaveLength(0);
  });

  it('bounds the fan-out to the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const spy = stubFetch(async (url, _init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const resource = ownerOf(url);
      return json(resource === undefined ? [] : [ROW[resource]]);
    });
    const hits = await makeOps(2).searchAcrossResources('acme');
    expect(hits).toHaveLength(SUPPORTED.length);
    expect(spy.calls).toHaveLength(SUPPORTED.length);
    expect(peak).toBe(2);
  });

  it('returns full records when expand is true', async () => {
    stubRows();
    const hits = await makeOps().searchAcrossResources('acme', { expand: true });
    expect(hits.map((hit) => hit.resource)).toEqual(SUPPORTED);
    expect(hits[0].item).toHaveProperty('created_at', '2020-01-01');
    expect(hits[0].label).toBe('Acme');
    // The users hit carries the full record too, so the label falls back to the email field.
    expect(hits[7].item).toHaveProperty('created_at', '2020-01-01');
  });

  it('labels a hit by its name, else a user email, else its id', async () => {
    stubRows();
    const hits = await makeOps().searchAcrossResources('acme', { resources: ['users', 'groups'] });
    expect(hits[0].label).toBe('acme@example.com');
    const unnamed = stubRows(() => [{ id: 77 }]);
    const bare = await makeOps().searchAcrossResources('acme', { resources: ['groups'] });
    expect(bare[0].label).toBe('#77');
    expect(unnamed.calls).toHaveLength(1);
  });

  it('searches a repeated resource name once', async () => {
    const spy = stubRows();
    const hits = await makeOps().searchAcrossResources('acme', { resources: ['groups', 'groups'] });
    expect(hits.map((hit) => hit.resource)).toEqual(['groups']);
    expect(spy.calls).toHaveLength(1);
  });

  it('uses the helper tier only: no listAll or list primitive is called', async () => {
    const client = makeClient();
    const spies = SUPPORTED.flatMap((resource) => {
      const target = client[resource === 'asset_passwords' ? 'assetPasswords' : resource === 'password_folders' ? 'passwordFolders' : resource] as any;
      return [vi.spyOn(target, 'listAll'), vi.spyOn(target, 'list'), vi.spyOn(target, 'listPages')];
    });
    stubRows();
    const ops = new Operations(client);
    await ops.searchAcrossResources('acme');
    await ops.resolveAny('acme');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('issues no writes from either helper', async () => {
    const spy = stubRows();
    const ops = makeOps();
    await ops.searchAcrossResources('acme');
    await ops.resolveAny('acme');
    expect(spy.calls.length).toBeGreaterThan(0);
    expect(spy.calls.every((call) => String(call.init.method ?? 'GET').toUpperCase() === 'GET')).toBe(true);
  });

  it('rejects an empty query', async () => {
    const spy = stubRows();
    const rejected = await makeOps().searchAcrossResources('   ').then(
      () => { throw new Error('expected the call to reject'); },
      (error: unknown) => error as { code?: string },
    );
    expect(rejected.code).toBe('CONFIG_ERROR');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('operations.resolveAny', () => {
  afterEach(() => clearFetch());

  it('resolves a domain to a company and a serial to an asset in one call', async () => {
    stubRows();
    const result = await makeOps().resolveAny('acme.com', { resources: ['companies', 'assets'] });
    expect(result.hits.map((hit) => hit.resource)).toEqual(['companies', 'assets']);
    expect(result.hits.map((hit) => hit.id)).toEqual([11, 13]);
    expect(result.hits[0].item).toMatchObject({ id: 11, name: 'Acme' });
    expect(result.hits[1].item).toMatchObject({ id: 13, primary_serial: 'acme.com' });
    expect(result.hits.every((hit) => hit.label.length > 0)).toBe(true);
    expect(result.truncated).toEqual([]);
    expect(result.scanned).toBeGreaterThanOrEqual(2);
  });

  it('returns candidates instead of throwing when several resources match', async () => {
    stubRows();
    const result = await makeOps().resolveAny('acme', { resources: ['companies', 'users'] });
    expect(result.hits.map((hit) => hit.resource)).toEqual(['companies', 'users']);
    expect(result.hits.map((hit) => hit.id)).toEqual([11, 18]);
    expect(result.truncated).toEqual([]);
  });

  it('keeps a resource own ambiguous candidates instead of failing the whole call', async () => {
    stubRows((resource) =>
      resource === 'companies'
        ? [{ id: 1, name: 'Acme', slug: 'acme' }, { id: 2, name: 'Acme', slug: 'acme' }]
        : [ROW[resource]],
    );
    const result = await makeOps().resolveAny('acme', { resources: ['companies', 'users'] });
    // Companies matched two records and could not choose: both candidates are reported, with the
    // ids the resource named, and the users hit is not lost with them.
    expect(result.hits.filter((hit) => hit.resource === 'companies').map((hit) => hit.id)).toEqual([1, 2]);
    expect(result.hits.filter((hit) => hit.resource === 'companies').every((hit) => hit.item === null)).toBe(true);
    expect(result.hits.filter((hit) => hit.resource === 'users').map((hit) => hit.id)).toEqual([18]);
  });

  it('returns an empty result after a complete bounded search', async () => {
    stubRows(() => []);
    const result = await makeOps().resolveAny('nothing-matches-anywhere', {
      resources: ['companies', 'assets', 'users'],
    });
    expect(result).toEqual({ hits: [], truncated: [], scanned: 0 });
  });

  it('reports a truncated per-resource scan in truncated instead of dropping it', async () => {
    stubRows((resource) => (resource === 'users' ? [ROW.users] : otherRows(25)));
    const result = await makeOps().resolveAny('acme', { resources: ['companies', 'users'] });
    expect(result.hits.map((hit) => hit.resource)).toEqual(['users']);
    expect(result.truncated).toEqual(['companies']);
  });

  it('throws RESOLUTION_TRUNCATED when every scan was truncated and nothing matched', async () => {
    stubRows(() => otherRows(25));
    const rejected = await makeOps().resolveAny('never-matches', { resources: ['companies'] }).then(
      () => { throw new Error('expected the call to reject'); },
      (error: unknown) => error as { code?: string },
    );
    expect(rejected.code).toBe('RESOLUTION_TRUNCATED');
  });

  it('throws NOT_FOUND for a definite id that no requested resource holds', async () => {
    const spy = stubFetch(() => json({ error: 'not found' }, 404));
    const rejected = await makeOps().resolveAny(4242, { resources: ['companies', 'assets'] }).then(
      () => { throw new Error('expected the call to reject'); },
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(rejected.code).toBe('NOT_FOUND');
    expect(rejected.message).toContain('4242');
    expect(spy.calls).toHaveLength(2);
  });

  it('reads a numeric string and an object id as the same definite id', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeOps().resolveAny('4242', { resources: ['companies'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeOps().resolveAny({ id: 4242 }, { resources: ['companies'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Zero is not a definite id: it is an incomplete identifier, so a complete miss is an empty result.
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeOps().resolveAny(0, { resources: ['companies'] })).resolves.toEqual({ hits: [], truncated: [], scanned: 0 });
  });

  it('rejects an unsupported resource name with CONFIG_ERROR', async () => {
    const spy = stubRows();
    const rejected = await makeOps()
      .resolveAny('acme', { resources: ['comapnies'] as unknown as SearchableResource[] })
      .then(
        () => { throw new Error('expected the call to reject'); },
        (error: unknown) => error as { code?: string; message: string },
      );
    expect(rejected.code).toBe('CONFIG_ERROR');
    expect(rejected.message).toContain('comapnies');
    expect(rejected.message).toContain('password_folders');
    expect(spy.calls).toHaveLength(0);
  });

  it('rejects an unsupported resource name and an empty resource list on search', async () => {
    const spy = stubRows();
    const unknown = await makeOps()
      .searchAcrossResources('acme', { resources: ['missing'] as unknown as SearchableResource[] })
      .then(
        () => { throw new Error('expected the call to reject'); },
        (error: unknown) => error as { code?: string; message: string },
      );
    expect(unknown.code).toBe('CONFIG_ERROR');
    expect(unknown.message).toContain('"missing"');
    expect(unknown.message).toContain('"asset_passwords"');
    await expect(makeOps().searchAcrossResources('acme', { resources: [] })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeOps().resolveAny('acme', { resources: [] })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(spy.calls).toHaveLength(0);
  });

  it('throws CONFIG_ERROR when a resource ignores resolutionDetails', async () => {
    const fake = {
      config: { concurrency: 4 },
      companies: { resolve: async () => ({ id: 1, name: 'Acme' }) },
    } as unknown as HuduClient;
    const rejected = await new Operations(fake)
      .resolveAny('acme', { resources: ['companies'] })
      .then(
        () => { throw new Error('expected the call to reject'); },
        (error: unknown) => error as { code?: string; message: string },
      );
    expect(rejected.code).toBe('CONFIG_ERROR');
    expect(rejected.message).toContain('resolutionDetails');
  });
  it('reports exactly what each resource resolution reported', async () => {
    const decided = { id: 3, name: 'Acme', slug: 'acme' };
    const fake = (resolve: () => Promise<unknown>): HuduClient =>
      ({ config: { concurrency: 4 }, companies: { resolve } }) as unknown as HuduClient;

    // A resource that decided a record but stopped its scan is truncated, never a miss.
    const cut = await new Operations(
      fake(async () => ({ value: decided, resolutionCost: 'server-filter', scanned: 7, scanTruncated: true })),
    )
      .resolveAny('acme', { resources: ['companies'] })
      .then(
        () => { throw new Error('expected the call to reject'); },
        (error: unknown) => error as { code?: string },
      );
    expect(cut.code).toBe('RESOLUTION_TRUNCATED');

    // Candidate ids without a decided record are still candidates: the id and label are real.
    const idsOnly = await new Operations(
      fake(async () => ({
        value: null, resolutionCost: 'server-filter', scanned: 3, scanTruncated: false,
        candidates: [{ id: 5, label: 'candidate 5' }],
      })),
    ).resolveAny('acme', { resources: ['companies'] });
    expect(idsOnly.hits).toEqual([{ resource: 'companies', id: 5, label: 'candidate 5', item: null }]);

    // A decided record without reported candidates is labelled from the record itself.
    const noCandidates = await new Operations(
      fake(async () => ({ value: decided, resolutionCost: 'direct', scanned: 1, scanTruncated: false })),
    ).resolveAny('acme', { resources: ['companies'] });
    expect(noCandidates.hits[0]).toMatchObject({ resource: 'companies', id: 3, label: 'Acme' });

    // An ambiguous resource that named no ids contributes nothing, and does not fail the call.
    const ambiguous = await new Operations(
      fake(async () => { throw ResolutionError.ambiguous('several records match'); }),
    ).resolveAny('acme', { resources: ['companies'] });
    expect(ambiguous).toEqual({ hits: [], truncated: [], scanned: 0 });

    // A truncated error from the resource is reported as truncated, not as not-found.
    await expect(
      new Operations(fake(async () => { throw ResolutionError.truncated('cap reached'); }))
        .resolveAny('acme', { resources: ['companies'] }),
    ).rejects.toMatchObject({ code: 'RESOLUTION_TRUNCATED' });

    // A transport failure is not a resolution answer: it propagates.
    await expect(
      new Operations(fake(async () => { throw new Error('socket hang up'); }))
        .resolveAny('acme', { resources: ['companies'] }),
    ).rejects.toThrow('socket hang up');

    // An identifier kind the SDK does not read is not a definite id.
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeOps().resolveAny(true as unknown as Identifier, { resources: ['companies'] }))
      .rejects.toMatchObject({ code: 'CONFIG_ERROR' });

    // Neither is id 0: a definite id must name a record.
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeOps().resolveAny({ id: 0 } as Identifier, { resources: ['companies'] }))
      .resolves.toEqual({ hits: [], truncated: [], scanned: 0 });
  });
});
