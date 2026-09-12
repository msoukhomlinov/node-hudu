/**
 * FoldersResource tests — primitive rows and the helper tier, against mocked
 * envelopes. Never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HuduClient } from '../../src/client.js';
import type { AuditEvent } from '../../src/types/common.js';
import { HuduConfigError, NotFoundError, ResolutionError, ValidationFailedError } from '../../src/errors.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://hudu.example.com/api/v1';

/** The fields a summary interface declares, read from its source so a future widening cannot slip past. */
function declaredSummaryFields(file: string, name: string): string[] {
  const src = readFileSync(join(__dirname, file), 'utf8');
  const match = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src);
  if (!match) throw new Error(`interface ${name} not found in ${file}`);
  return [...match[1]!.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]!);
}


function makeClient(overrides: Record<string, unknown> = {}) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...overrides });
}

/** A full folder record (api-docs Folder). */
function folder(over: Record<string, unknown> = {}) {
  return {
    id: 12,
    company_id: 42,
    icon: 'fa-folder',
    description: 'internal description',
    name: 'Runbooks',
    parent_folder_id: null,
    folder_type: 'article',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    ...over,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function auditSpy() {
  const events: AuditEvent[] = [];
  return { events, hook: (event: AuditEvent) => { events.push(event); } };
}

/** Answer the first page with `items`, then exhaust. */
function listOnce(items: unknown[]) {
  let n = 0;
  return stubFetch(() => { n += 1; return json(n === 1 ? items : []); });
}

describe('FoldersResource', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped folders list', async () => {
    const spy = listOnce([folder()]);
    const res = await makeClient().folders.listAll({});
    expect(res).toEqual([folder()]);
    expect(spy.calls[0].url).toContain(`${BASE}/folders`);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => folder({ id: i + 1 }));
    const spy = stubFetch((url) => (url.includes('page=1') ? json({ folders: page1 }) : json({ folders: [folder({ id: 99 })] })));
    const res = await makeClient().folders.listAll({});
    expect(res).toHaveLength(26);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    const spy = stubFetch(() => { n += 1; return n === 1 ? json({ folder: folder() }) : json({ error: 'boom' }, 500); });
    await client.folders.get(12);
    expect(spy.calls).toHaveLength(1);
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    expect(audit.events[0]!.operation).toBe('folders.get');

    const err = await client.folders.delete(12).then(
      () => { throw new Error('expected the request to reject'); },
      (e: { correlationId?: string }) => e,
    );
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events.at(-1)!.correlationId).toBe(err.correlationId);
    expect(audit.events.at(-1)!.outcome).toBe('error');
  });

  it('returns the unwrapped folders record', async () => {
    const spy = stubFetch(() => json({ folder: folder() }));
    const res = await makeClient().folders.get(12);
    expect(res).toEqual(folder());
    expect(spy.calls[0].url).toBe(`${BASE}/folders/12`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'missing' }, 404));
    const err = await makeClient().folders.get(999).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as NotFoundError,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('returns the created folders record', async () => {
    const spy = stubFetch(() => json({ folder: folder() }, 201));
    const res = await makeClient().folders.create({ name: 'Runbooks' });
    expect(res).toEqual(folder());
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].url).toBe(`${BASE}/folders`);
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ folder: { name: 'Runbooks' } }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().folders.create({ name: 'Runbooks' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'POST', path: '/folders' });
    expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('returns the updated folders record', async () => {
    const spy = stubFetch(() => json({ folder: folder({ name: 'New Runbooks' }) }));
    const res = await makeClient().folders.update(12, { name: 'New Runbooks' });
    expect(res).toEqual(folder({ name: 'New Runbooks' }));
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].url).toBe(`${BASE}/folders/12`);
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().folders.update(12, { name: 'x' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'PUT', path: '/folders/12' });
    expect(result.checks.map((check) => check.name)).toEqual(['target-identifier', 'payload-present']);
  });

  it('unwraps the PUT response by singleKey', async () => {
    stubFetch(() => json({ folder: folder() }));
    const res = await makeClient().folders.update(12, { name: 'Runbooks' });
    expect(res).toEqual(folder());
    expect(res).not.toHaveProperty('folder');
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().folders.delete(12)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[0].url).toBe(`${BASE}/folders/12`);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().folders.delete(12, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'DELETE', path: '/folders/12' });
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const stale = stubFetch(() => json({ folder: folder({ updated_at: '2026-09-02T00:00:00Z' }) }));
    await expect(
      makeClient().folders.update(12, { name: 'x' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'STALE_OBJECT', category: 'conflict', retryable: false });
    expect(stale.calls.map((call) => call.init.method)).toEqual(['GET']);
    clearFetch();

    const ok = stubFetch(() => json({ folder: folder() }));
    await expect(makeClient().folders.update(12, { name: 'x' }, { expectedUpdatedAt: '2026-09-02T00:00:00Z' }))
      .resolves.toEqual(folder());
    expect(ok.calls.map((call) => call.init.method)).toEqual(['GET', 'PUT']);
  });
});

describe('FoldersResource helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ folder: folder() }));
    const res = await makeClient().folders.resolve(12);
    expect(res).toEqual({
      id: 12, name: 'Runbooks', company_id: 42, parent_folder_id: null, folder_type: 'article', icon: 'fa-folder', updated_at: '2026-09-02T00:00:00Z',
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe(`${BASE}/folders/12`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'missing' }, 404));
    await expect(makeClient().folders.resolve({ id: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    const spy = listOnce({ folders: [folder({ id: 1, name: 'Other' }), folder({ id: 2, name: 'Runbooks' })] });
    const res = await makeClient().folders.resolve('Runbooks');
    expect(res).toMatchObject({ id: 2, name: 'Runbooks' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('name=Runbooks');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json({ folders: [] }));
    await expect(makeClient().folders.resolve('Absent')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('throws RESOLUTION_AMBIGUOUS when a name matches several folders', async () => {
    listOnce({ folders: [folder({ id: 1, name: 'Runbooks' }), folder({ id: 2, name: 'Runbooks', company_id: 7 })] });
    const err = await makeClient().folders.resolve({ name: 'Runbooks' }).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ResolutionError,
    );
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 2]);
    expect(err.suggestedAction).toContain('candidate ids');
  });

  it('returns FolderSummary', async () => {
    stubFetch(() => json({ folders: [folder()] }));
    const summary = await makeClient().folders.resolve({ name: 'Runbooks' });
    expect(Object.keys(summary as object).sort()).toEqual(
      ['company_id', 'folder_type', 'icon', 'id', 'name', 'parent_folder_id', 'updated_at'],
    );
    expect(summary).not.toHaveProperty('description');
    expect(summary).not.toHaveProperty('created_at');
  });

  it('expand: true returns the full folder', async () => {
    stubFetch(() => json({ folders: [folder()] }));
    const full = await makeClient().folders.resolve({ name: 'Runbooks' }, { expand: true });
    expect(full).toEqual(folder());
    expect(full).toHaveProperty('description', 'internal description');
  });

  it('narrows the name lookup with company_id and folder_type', async () => {
    const spy = stubFetch(() => json({ folders: [folder({ id: 5 })] }));
    const res = await makeClient().folders.resolve({ name: 'Runbooks', company_id: 42, folder_type: 'photo' });
    expect(res).toMatchObject({ id: 5 });
    expect(spy.calls[0].url).toContain('company_id=42');
    expect(spy.calls[0].url).toContain('folder_type=photo');
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap stops the search', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => folder({ id: i + 1, name: 'other' }));
    const spy = stubFetch(() => json({ folders: fullPage }));
    const err = await makeClient().folders.resolve('Never').then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ResolutionError,
    );
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(spy.calls).toHaveLength(4);
  });

  it('reports resolution details for the expanded record', async () => {
    stubFetch(() => json({ folders: [folder()] }));
    const resolution = await makeClient().folders.resolve({ name: 'Runbooks' }, { expand: true, resolutionDetails: true });
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.value).toEqual(folder());
  });

  it('refuses an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json({ folders: [] }));
    const err = await makeClient().folders.resolve({ slug: 'runbooks' }).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ValidationFailedError,
    );
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect(err.message).toContain('accepted');
    expect(spy.calls).toHaveLength(0);
  });

  it('refuses an invalid id instead of guessing', async () => {
    await expect(makeClient().folders.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('refuses the expectedUpdatedAt guard on create and delete', async () => {
    // Plan `staleCheck: unavailable` on create/delete: the guard compares an existing
    // revision, so it is refused there rather than silently ignored.
    const spy = stubFetch(() => json({ folder: folder() }));
    const client = makeClient();
    await expect(
      client.folders.create({ name: 'Runbooks' }, { expectedUpdatedAt: '2026-09-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(HuduConfigError);
    await expect(
      client.folders.delete(12, { expectedUpdatedAt: '2026-09-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('FoldersResource identifier and guard edges', () => {
  afterEach(() => clearFetch());

  it('refuses malformed identifiers instead of guessing', async () => {
    const client = makeClient();
    await expect(client.folders.resolve('')).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.folders.resolve({ id: 0 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.folders.resolve({ id: 'x' as unknown as number })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.folders.resolve({ name: 42 as unknown as string })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.folders.resolve({ name: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.folders.resolve({ id: 1, name: 'both' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.folders.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('returns the resolution of the full records when both flags are set', async () => {
    stubFetch(() => json({ folders: [folder()] }));
    const resolution = await makeClient().folders.resolve({ name: 'Runbooks' }, { expand: true, resolutionDetails: true });
    expect(resolution.value).toEqual(folder());
  });

  it('reports an undecided-by-nothing resolution when the scan finds no folder', async () => {
    stubFetch(() => json({ folders: [] }));
    const resolution = await makeClient().folders.resolve({ name: 'Absent' }, { resolutionDetails: true });
    expect(resolution.value).toBeNull();
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.resolutionCost).toBe('server-filter');
  });

  it('lists and pages without parameters', async () => {
    let n = 0;
    stubFetch(() => { n += 1; return n <= 2 ? json({ folders: [folder()] }) : json({ folders: [] }); });
    const client = makeClient();
    const streamed: unknown[] = [];
    for await (const item of client.folders.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of client.folders.listPages()) pages.push(page);
    expect((pages[0] as { items: unknown[] }).items).toHaveLength(1);
  });

  it('reports an undecided-by-nothing resolution for the full record shape too', async () => {
    stubFetch(() => json({ folders: [] }));
    const resolution = await makeClient().folders.resolve({ name: 'Absent' }, { expand: true, resolutionDetails: true });
    expect(resolution.value).toBeNull();
    expect(resolution.scanTruncated).toBe(false);
  });
});


describe('FolderSummary projection pins the declared interface', () => {
  afterEach(() => clearFetch());

  /** One distinct fixture value per declared field, so a dropped field cannot hide. */
  const SENTINEL: Record<string, unknown> = { id: 987, name: 'Runbooks', company_id: 654, parent_folder_id: 321, folder_type: 'photo', icon: 'SENTINEL-icon', updated_at: 'SENTINEL-updated-at' };

  it('populates every field the FolderSummary interface declares', async () => {
    const declared = declaredSummaryFields('../../src/types/folder.ts', 'FolderSummary').sort();
    expect(declared).toEqual(Object.keys(SENTINEL).sort());
    stubFetch(() => json({ folders: [{ id: 987, name: 'Runbooks', company_id: 654, parent_folder_id: 321, folder_type: 'photo', icon: 'SENTINEL-icon', updated_at: 'SENTINEL-updated-at' }] }));
    const projected = (await makeClient().folders.resolve({ name: 'Runbooks' })) as unknown as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual(declared);
    for (const key of declared) expect(projected[key], key).toEqual(SENTINEL[key]);
  });
});
