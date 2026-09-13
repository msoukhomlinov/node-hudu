/**
 * PasswordFoldersResource tests — primitive rows and the helper tier, against mocked
 * envelopes. Sensitive resource: the redaction contract is asserted here too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HuduClient } from '../../src/client.js';
import type { AuditEvent } from '../../src/types/common.js';
import { HuduConfigError, NotFoundError, ResolutionError, ValidationFailedError } from '../../src/errors.js';
import { REDACTED, redact } from '../../src/logger.js';
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

/** A full password folder record (api-docs Password_Folder). */
function passwordFolder(over: Record<string, unknown> = {}) {
  return {
    id: 21,
    company_id: 42,
    description: 'internal description',
    name: 'Prod secrets',
    slug: 'prod-secrets',
    security: 'specific',
    allowed_groups: [3, 4],
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

function listOnce(envelope: unknown) {
  let n = 0;
  return stubFetch(() => { n += 1; return json(n === 1 ? envelope : { password_folders: [] }); });
}

describe('PasswordFoldersResource', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped password_folders list', async () => {
    const spy = listOnce({ password_folders: [passwordFolder()] });
    const res = await makeClient().passwordFolders.listAll({});
    expect(res).toEqual([passwordFolder()]);
    expect(spy.calls[0].url).toContain(`${BASE}/password_folders`);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => passwordFolder({ id: i + 1 }));
    const spy = stubFetch((url) => (url.includes('page=1') ? json({ password_folders: page1 }) : json({ password_folders: [passwordFolder({ id: 99 })] })));
    const res = await makeClient().passwordFolders.listAll({});
    expect(res).toHaveLength(26);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    const spy = stubFetch(() => { n += 1; return n === 1 ? json({ password_folder: passwordFolder() }) : json({ error: 'boom' }, 500); });
    await client.passwordFolders.get(21);
    expect(spy.calls).toHaveLength(1);
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    expect(audit.events[0]!.operation).toBe('password_folders.get');

    const err = await client.passwordFolders.delete(21).then(
      () => { throw new Error('expected the request to reject'); },
      (e: { correlationId?: string }) => e,
    );
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events.at(-1)!.correlationId).toBe(err.correlationId);
    expect(audit.events.at(-1)!.outcome).toBe('error');
  });

  it('does not log credential-shaped fields and redact() removes them from the returned data', async () => {
    const logged: unknown[] = [];
    const logger = {
      debug: (message: string, meta?: Record<string, unknown>) => logged.push([message, meta]),
      info: (message: string, meta?: Record<string, unknown>) => logged.push([message, meta]),
      warn: (message: string, meta?: Record<string, unknown>) => logged.push([message, meta]),
      error: (message: string, meta?: Record<string, unknown>) => logged.push([message, meta]),
    };
    const client = makeClient({ logger });
    const secret = { ...passwordFolder(), password: 'hunter2', otp_secret: 'JBSWY3DPEHPK3PXP' };
    stubFetch(() => json({ password_folder: secret }));

    const record = (await client.passwordFolders.get(21)) as unknown as Record<string, unknown>;
    // Returned data is never redacted implicitly: the caller decides.
    expect(record.password).toBe('hunter2');
    // ...and the credential value never reaches the logger.
    expect(JSON.stringify(logged)).not.toContain('hunter2');
    expect(JSON.stringify(logged)).not.toContain('JBSWY3DPEHPK3PXP');

    const safe = redact(record) as Record<string, unknown>;
    expect(safe.password).toBe(REDACTED);
    expect(safe.otp_secret).toBe(REDACTED);
    expect(safe.name).toBe('Prod secrets');
    // redact() returns a copy — the caller's record keeps its own value.
    expect(record.password).toBe('hunter2');
  });

  it('returns the unwrapped password_folders record', async () => {
    const spy = stubFetch(() => json({ password_folder: passwordFolder() }));
    const res = await makeClient().passwordFolders.get(21);
    expect(res).toEqual(passwordFolder());
    expect(spy.calls[0].url).toBe(`${BASE}/password_folders/21`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'missing' }, 404));
    const err = await makeClient().passwordFolders.get(999).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as NotFoundError,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('returns the created password_folders record', async () => {
    const spy = stubFetch(() => json({ password_folder: passwordFolder() }, 201));
    const res = await makeClient().passwordFolders.create({ name: 'Prod secrets' });
    expect(res).toEqual(passwordFolder());
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].url).toBe(`${BASE}/password_folders`);
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ name: 'Prod secrets' }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().passwordFolders.create({ name: 'Prod secrets' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'POST', path: '/password_folders' });
  });

  it('returns the updated password_folders record', async () => {
    const spy = stubFetch(() => json({ password_folder: passwordFolder({ name: 'Renamed' }) }));
    const res = await makeClient().passwordFolders.update(21, { name: 'Renamed' });
    expect(res).toEqual(passwordFolder({ name: 'Renamed' }));
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].url).toBe(`${BASE}/password_folders/21`);
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().passwordFolders.update(21, { name: 'x' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'PUT', path: '/password_folders/21' });
    expect(result.target.ids).toEqual([21]);
  });

  it('unwraps the PUT response by singleKey', async () => {
    stubFetch(() => json({ password_folder: passwordFolder() }));
    const res = await makeClient().passwordFolders.update(21, { name: 'Prod secrets' });
    expect(res).toEqual(passwordFolder());
    expect(res).not.toHaveProperty('password_folder');
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().passwordFolders.delete(21)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[0].url).toBe(`${BASE}/password_folders/21`);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = await makeClient().passwordFolders.delete(21, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'DELETE', path: '/password_folders/21' });
    expect(result.impact.reversible).toBe(false);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const stale = stubFetch(() => json({ password_folder: passwordFolder({ updated_at: '2026-09-02T00:00:00Z' }) }));
    await expect(
      makeClient().passwordFolders.update(21, { name: 'x' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'STALE_OBJECT', category: 'conflict' });
    expect(stale.calls.map((call) => call.init.method)).toEqual(['GET']);
    clearFetch();

    const ok = stubFetch(() => json({ password_folder: passwordFolder() }));
    await expect(
      makeClient().passwordFolders.update(21, { name: 'x' }, { expectedUpdatedAt: '2026-09-02T00:00:00Z' }),
    ).resolves.toEqual(passwordFolder());
    expect(ok.calls.map((call) => call.init.method)).toEqual(['GET', 'PUT']);
  });
});

describe('PasswordFoldersResource helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ password_folder: passwordFolder() }));
    const res = await makeClient().passwordFolders.resolve(21);
    expect(res).toEqual({
      id: 21, name: 'Prod secrets', company_id: 42, slug: 'prod-secrets', security: 'specific', updated_at: '2026-09-02T00:00:00Z',
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe(`${BASE}/password_folders/21`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'missing' }, 404));
    await expect(makeClient().passwordFolders.resolve({ id: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    const spy = listOnce({ password_folders: [passwordFolder({ id: 1, name: 'Other' }), passwordFolder({ id: 2, name: 'Prod secrets' })] });
    const res = await makeClient().passwordFolders.resolve('Prod secrets');
    expect(res).toMatchObject({ id: 2, name: 'Prod secrets' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('name=Prod+secrets');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json({ password_folders: [] }));
    await expect(makeClient().passwordFolders.resolve('Absent')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('returns PasswordFolderSummary', async () => {
    stubFetch(() => json({ password_folders: [passwordFolder()] }));
    const summary = await makeClient().passwordFolders.resolve({ name: 'Prod secrets' });
    expect(Object.keys(summary as object).sort()).toEqual(
      ['company_id', 'id', 'name', 'security', 'slug', 'updated_at'],
    );
    // The access-control list and the bulky free text are dropped.
    expect(summary).not.toHaveProperty('allowed_groups');
    expect(summary).not.toHaveProperty('description');
    expect(summary).not.toHaveProperty('created_at');
  });

  it('expand: true returns the full folder', async () => {
    stubFetch(() => json({ password_folders: [passwordFolder()] }));
    const full = await makeClient().passwordFolders.resolve({ name: 'Prod secrets' }, { expand: true });
    expect(full).toEqual(passwordFolder());
    expect(full).toHaveProperty('allowed_groups', [3, 4]);
  });

  it('narrows the name lookup with company_id', async () => {
    const spy = stubFetch(() => json({ password_folders: [passwordFolder({ id: 9 })] }));
    const res = await makeClient().passwordFolders.resolve({ name: 'Prod secrets', company_id: 42 });
    expect(res).toMatchObject({ id: 9 });
    expect(spy.calls[0].url).toContain('company_id=42');
  });

  it('throws RESOLUTION_AMBIGUOUS when a name matches several folders', async () => {
    listOnce({ password_folders: [passwordFolder({ id: 1 }), passwordFolder({ id: 2, company_id: 7 })] });
    const err = await makeClient().passwordFolders.resolve({ name: 'Prod secrets' }).then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ResolutionError,
    );
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 2]);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap stops the search', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => passwordFolder({ id: i + 1, name: 'other' }));
    const spy = stubFetch(() => json({ password_folders: fullPage }));
    const err = await makeClient().passwordFolders.resolve('Never').then(
      () => { throw new Error('expected the request to reject'); },
      (e: unknown) => e as ResolutionError,
    );
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(spy.calls).toHaveLength(4);
  });

  it('throws RESOLUTION_TRUNCATED instead of the one matching password folder when the cap stopped the scan', async () => {
    const page = [passwordFolder({ id: 1 }), ...Array.from({ length: 24 }, (_, i) => passwordFolder({ id: 100 + i, name: 'other', slug: `s${i}` }))];
    const others = Array.from({ length: 25 }, (_, i) => passwordFolder({ id: 200 + i, name: 'other', slug: `o${i}` }));
    stubFetch((url) => json({ password_folders: url.includes('page=1') ? page : others }));
    await expect(makeClient().passwordFolders.resolve({ name: 'Prod secrets' })).rejects.toMatchObject({
      code: 'RESOLUTION_TRUNCATED',
      category: 'resolution',
    });
  });

  it('reports the resolution cost with resolutionDetails', async () => {
    stubFetch(() => json({ password_folders: [passwordFolder()] }));
    const resolution = await makeClient().passwordFolders.resolve({ name: 'Prod secrets' }, { resolutionDetails: true });
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.value).toMatchObject({ id: 21 });
    expect(resolution.value).not.toHaveProperty('allowed_groups');
  });

  it('refuses an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json({ password_folders: [] }));
    await expect(makeClient().passwordFolders.resolve({ slug: 'prod-secrets' }))
      .rejects.toBeInstanceOf(ValidationFailedError);
    expect(spy.calls).toHaveLength(0);
  });

  it('returns matching PasswordFolderSummary records', async () => {
    const spy = listOnce({ password_folders: [passwordFolder({ id: 1 }), passwordFolder({ id: 2 })] });
    const res = await makeClient().passwordFolders.search('prod');
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ id: 1 });
    expect(res[0]).not.toHaveProperty('allowed_groups');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('search=prod');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = listOnce({ password_folders: [passwordFolder({ id: 1 }), passwordFolder({ id: 2 }), passwordFolder({ id: 3 })] });
    const res = await makeClient().passwordFolders.search('prod', { limit: 2, company_id: 42 });
    expect(res).toHaveLength(2);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('page_size=2');
    expect(spy.calls[0].url).toContain('company_id=42');

    await expect(makeClient().passwordFolders.search('prod', { limit: 101 })).rejects.toBeInstanceOf(HuduConfigError);
  });
});

describe('PasswordFoldersResource identifier and guard edges', () => {
  afterEach(() => clearFetch());

  it('refuses malformed identifiers instead of guessing', async () => {
    const client = makeClient();
    await expect(client.passwordFolders.resolve('')).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.passwordFolders.resolve({ id: 0 })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.passwordFolders.resolve({ id: 'x' as unknown as number })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.passwordFolders.resolve({ name: 42 as unknown as string })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.passwordFolders.resolve({ name: '' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.passwordFolders.resolve({ id: 1, name: 'both' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(client.passwordFolders.resolve(0)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('returns the resolution of the full records when both flags are set', async () => {
    stubFetch(() => json({ password_folders: [passwordFolder()] }));
    const resolution = await makeClient().passwordFolders.resolve(
      { name: 'Prod secrets' },
      { expand: true, resolutionDetails: true },
    );
    expect(resolution.value).toEqual(passwordFolder());
  });

  it('lists and pages without parameters', async () => {
    let n = 0;
    stubFetch(() => { n += 1; return n <= 2 ? json({ password_folders: [passwordFolder()] }) : json({ password_folders: [] }); });
    const client = makeClient();
    const streamed: unknown[] = [];
    for await (const item of client.passwordFolders.list()) streamed.push(item);
    expect(streamed).toHaveLength(1);
    const pages: unknown[] = [];
    for await (const page of client.passwordFolders.listPages()) pages.push(page);
    expect((pages[0] as { items: unknown[] }).items).toHaveLength(1);
  });

  it('refuses the expectedUpdatedAt guard on create and delete', async () => {
    // Plan `staleCheck: unavailable` on create/delete: the guard compares an existing
    // revision, so it is refused there rather than silently ignored.
    const spy = stubFetch(() => json({ password_folder: passwordFolder() }));
    const client = makeClient();
    await expect(
      client.passwordFolders.create({ name: 'Prod secrets' }, { expectedUpdatedAt: '2026-09-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(HuduConfigError);
    await expect(
      client.passwordFolders.delete(21, { expectedUpdatedAt: '2026-09-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});


describe('PasswordFolderSummary projection pins the declared interface', () => {
  afterEach(() => clearFetch());

  /** One distinct fixture value per declared field, so a dropped field cannot hide. */
  const SENTINEL: Record<string, unknown> = { id: 987, name: 'Prod secrets', company_id: 654, slug: 'SENTINEL-slug', security: 'specific', updated_at: 'SENTINEL-updated-at' };

  it('populates every field the PasswordFolderSummary interface declares', async () => {
    const declared = declaredSummaryFields('../../src/types/password_folder.ts', 'PasswordFolderSummary').sort();
    expect(declared).toEqual(Object.keys(SENTINEL).sort());
    stubFetch(() => json({ password_folders: [{ id: 987, name: 'Prod secrets', company_id: 654, slug: 'SENTINEL-slug', security: 'specific', updated_at: 'SENTINEL-updated-at' }] }));
    const projected = (await makeClient().passwordFolders.resolve({ name: 'Prod secrets' })) as unknown as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual(declared);
    for (const key of declared) expect(projected[key], key).toEqual(SENTINEL[key]);
  });
});

describe('PasswordFoldersResource search overload call shapes', () => {
  afterEach(() => clearFetch());

  it('accepts the loose option bag and the narrow expand form', async () => {
    // Compile-shape pin: loose `{ limit, company_id }` and narrow `{ expand: true }` must
    // both typecheck against the PUBLIC overloads.
    const client = makeClient();
    stubFetch(() => json({ password_folders: [passwordFolder()] }));
    const loose = await client.passwordFolders.search('prod', { limit: 5, company_id: 42 });
    const expanded = await client.passwordFolders.search('prod', { expand: true });
    const both = await client.passwordFolders.search('prod', { limit: 5, expand: true });
    expect(loose[0]).not.toHaveProperty('allowed_groups');
    expect(expanded[0]).toHaveProperty('allowed_groups');
    expect(both[0]).toHaveProperty('allowed_groups');
  });
});
