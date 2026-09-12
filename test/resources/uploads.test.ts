/**
 * UploadsResource tests incl. multipart upload.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError } from '../../src/errors.js';
import type { AuditEvent, DryRunResult, Resolution } from '../../src/types/common.js';
import type { Upload } from '../../src/types/upload.js';
import type { UploadSummary } from '../../src/types/upload.js';
import { stubFetch, json, text, empty, clearFetch } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const upload = JSON.parse(readFileSync(join(__dirname, '../__fixtures__/upload.json'), 'utf8'));

function makeClient() { return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }); }

describe('UploadsResource', () => {
  afterEach(() => clearFetch());

  it('upload sends a multipart FormData body', async () => {
    const spy = stubFetch(() => json(upload, 201));
    const file = new Blob(['hello'], { type: 'text/plain' });
    const res = await makeClient().uploads.upload(file, { uploadable_id: 5, uploadable_type: 'Article' });
    expect(res).toEqual(upload);

    const call = spy.calls[0];
    expect(call.url).toBe('https://hudu.example.com/api/v1/uploads');
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBeInstanceOf(FormData);
    const fd = call.init.body as FormData;
    expect(fd.has('file')).toBe(true);
    expect(fd.get('upload[uploadable_id]')).toBe('5');
    expect(fd.get('upload[uploadable_type]')).toBe('Article');
    expect(fd.get('uploadable_id')).toBeNull();
    expect(fd.get('uploadable_type')).toBeNull();
  });


  it('upload converts a Node Buffer to a Blob so binary bytes are not mangled (close-check F1)', async () => {
    const spy = stubFetch(() => json(upload, 201));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]); // binary (PNG-like)
    await makeClient().uploads.upload(bytes, { uploadable_id: 7, uploadable_type: 'Article' });
    const fd = spy.calls[0].init.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    const sent = fd.get('file') as Blob;
    expect(sent).toBeInstanceOf(Blob);
    const roundtrip = new Uint8Array(await sent.arrayBuffer());
    expect(Array.from(roundtrip)).toEqual(Array.from(bytes));
  });

  it('listAll collects pages', async () => {
    const spy = stubFetch(() => json([upload]));
    const res = await makeClient().uploads.listAll({});
    expect(res).toEqual([upload]);
    expect(spy.calls[0].url).toContain('/api/v1/uploads');
  });

  it('list streams uploads', async () => {
    stubFetch(() => json([upload]));
    const out: unknown[] = [];
    for await (const u of makeClient().uploads.list({})) out.push(u);
    expect(out).toHaveLength(1);
  });

  it('get returns upload metadata by default', async () => {
    const spy = stubFetch(() => json(upload));
    const res = await makeClient().uploads.get(3);
    expect(res).toEqual(upload);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/uploads/3');
  });

  it('get with download:true requests the download query', async () => {
    const spy = stubFetch(() => text('file-bytes'));
    const res = await makeClient().uploads.get(3, { download: true });
    expect(res).toBeInstanceOf(Blob);
    expect(await (res as Blob).text()).toBe('file-bytes');
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/uploads/3?download=true');
  });

  it('delete returns void on 204', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().uploads.delete(3)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('DELETE');
  });
});


// ---------------------------------------------------------------------------
// Agent-execution layer (policy §4/§6-§9): resolve, dry-run, correlation ids and
// the plan's declared test rows for uploads.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeAuditedClient(events: AuditEvent[]) {
  return new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    onAudit: (event) => events.push(event),
  });
}

describe('UploadsResource — resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(upload));
    const res = await makeClient().uploads.resolve(3);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/uploads/3');
    expect(res?.id).toBe(3);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeClient().uploads.resolve(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws a validation error naming the accepted identifier kind', async () => {
    const spy = stubFetch(() => json(upload));
    const err = (await makeClient().uploads.resolve({ name: 'manual.txt' }).catch((e: unknown) => e)) as HuduError;
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.category).toBe('validation');
    expect(err.message).toContain('uploads.resolve accepts only an id');
    await expect(makeClient().uploads.resolve('')).rejects.toThrow(HuduConfigError);
    expect(err.message).toContain('{ id }');
    // No request is issued for an unsupported kind.
    expect(spy.calls).toHaveLength(0);
  });

  it('returns UploadSummary', async () => {
    stubFetch(() => json(upload));
    const summary = (await makeClient().uploads.resolve(3)) as UploadSummary;
    expect(Object.keys(summary).sort()).toEqual(
      ['created_date', 'ext', 'id', 'mime', 'name', 'size', 'uploadable_id', 'uploadable_type', 'url'],
    );
    expect((summary as unknown as { archived_at?: unknown }).archived_at).toBeUndefined();
  });

  it('expand: true returns the full upload', async () => {
    stubFetch(() => json(upload));
    const full = await makeClient().uploads.resolve(3, { expand: true });
    expect(full).toEqual(upload);
    expect(full?.archived_at).toBeNull();
  });

  it('resolutionDetails: true reports the direct cost', async () => {
    stubFetch(() => json(upload));
    const detail = (await makeClient().uploads.resolve(3, { resolutionDetails: true })) as Resolution<UploadSummary>;
    expect(detail.resolutionCost).toBe('direct');
    expect(detail.scanned).toBe(1);
    expect(detail.scanTruncated).toBe(false);
    expect(detail.candidates).toEqual([{ id: 3, label: 'upload 3 (manual.txt)' }]);
  });
});

describe('UploadsResource — plan rows', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped uploads list', async () => {
    stubFetch(() => json([upload]));
    const out: unknown[] = [];
    for await (const u of makeClient().uploads.list({})) out.push(u);
    expect(out).toEqual([upload]);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const spy = stubFetch(() => json([upload]));
    await makeClient().uploads.listAll({});
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toContain('page=1');
    expect(spy.calls[0]!.url).toContain('page_size=25');
  });

  it('returns the unwrapped uploads record', async () => {
    stubFetch(() => json(upload));
    await expect(makeClient().uploads.get(3)).resolves.toEqual(upload);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'nope' }, 404));
    await expect(makeClient().uploads.get(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().uploads.delete(3)).resolves.toBeUndefined();
    expect(spy.calls[0]!.init.method).toBe('DELETE');
  });

  it('calls the uploads.upload endpoint and normalises the result', async () => {
    const spy = stubFetch(() => json(upload, 201));
    const res = await makeClient().uploads.upload(new Blob(['x']), { uploadable_id: 5, uploadable_type: 'Article' });
    expect(res).toEqual(upload);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/uploads');
    expect(spy.calls[0]!.init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json(upload, 201));
    const result = (await makeClient().uploads.upload(
      new Blob(['x']),
      { uploadable_id: 5, uploadable_type: 'Article' },
      { dryRun: true },
    )) as DryRunResult<Upload>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.wouldApply).toBe(true);
    expect(result.operation).toBe('uploads.upload');
    expect(result.request).toEqual({ method: 'POST', path: '/uploads' });
    expect(result.target).toEqual({ resource: 'uploads', ids: [] });
    expect(result.checks).toEqual([
      { name: 'file-present', ok: true, detail: 'file bytes supplied' },
      { name: 'upload-target', ok: true, detail: 'uploadable Article:5' },
    ]);
    expect(result.warnings.join(' ')).toContain('cannot be promised');
  });

  it('dry-run reports the failed checks instead of inventing a pass', async () => {
    const spy = stubFetch(() => json(upload, 201));
    const result = (await makeClient().uploads.upload(
      undefined as unknown as Blob,
      {} as { uploadable_id: number; uploadable_type: string },
      { dryRun: true },
    )) as DryRunResult<Upload>;
    expect(spy.calls).toHaveLength(0);
    expect(result.checks.map((c) => c.ok)).toEqual([false, false]);
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().uploads.delete(3, { dryRun: true })) as DryRunResult<void>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('uploads.delete');
    expect(result.request).toEqual({ method: 'DELETE', path: '/uploads/3' });
    expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const events: AuditEvent[] = [];
    const spy = stubFetch(() => json([upload]));
    const client = makeAuditedClient(events);
    await client.uploads.listAll({});
    expect(events).toHaveLength(1);
    expect(events[0]!.correlationId).toMatch(UUID);
    expect(events[0]!.operation).toBe('uploads.list');
    expect(events[0]!.effect).toBe('read');

    spy.setHandler(() => json({ error: 'nope' }, 404));
    const err = (await client.uploads.get(404).catch((e: unknown) => e)) as HuduError;
    expect(err.correlationId).toMatch(UUID);
    expect(err.operation).toBe('uploads.get');
    const errorEvent = events[events.length - 1]!;
    expect(errorEvent.outcome).toBe('error');
    expect(errorEvent.correlationId).toBe(err.correlationId);

    spy.setHandler(() => empty(204));
    await client.uploads.delete(3);
    const deleteEvent = events[events.length - 1]!;
    expect(deleteEvent.operation).toBe('uploads.delete');
    expect(deleteEvent.effect).toBe('destructive');
    expect(deleteEvent.outcome).toBe('success');
    expect(deleteEvent.correlationId).toMatch(UUID);

    spy.setHandler(() => json(upload, 201));
    await client.uploads.upload(new Blob(['x']), { uploadable_id: 5, uploadable_type: 'Article' });
    const uploadEvent = events[events.length - 1]!;
    expect(uploadEvent.operation).toBe('uploads.upload');
    expect(uploadEvent.correlationId).toMatch(UUID);
    expect(uploadEvent.resourceIds).toEqual([5]);
  });
});


describe('UploadsResource — remaining branches', () => {
  afterEach(() => clearFetch());

  it('accepts a numeric string id and an { id } object', async () => {
    const spy = stubFetch(() => json(upload));
    await expect(makeClient().uploads.resolve('3')).resolves.toEqual(expect.objectContaining({ id: 3 }));
    await expect(makeClient().uploads.resolve({ id: 3 })).resolves.toEqual(expect.objectContaining({ id: 3 }));
    expect(spy.calls).toHaveLength(2);
  });

  it('rejects a null identifier without issuing a request', async () => {
    const spy = stubFetch(() => json(upload));
    await expect(makeClient().uploads.resolve(null as unknown as number)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('listPages yields pages and list/listAll default their params', async () => {
    stubFetch(() => json([upload]));
    const pages: unknown[] = [];
    for await (const p of makeClient().uploads.listPages({})) pages.push(p);
    expect(pages).toHaveLength(1);
    stubFetch(() => json([upload]));
    await expect(makeClient().uploads.listAll()).resolves.toEqual([upload]);
    stubFetch(() => json([upload]));
    const out: unknown[] = [];
    for await (const u of makeClient().uploads.list()) out.push(u);
    expect(out).toHaveLength(1);
  });

  it('an upload dry-run without a data bag reports the failed target check', async () => {
    const spy = stubFetch(() => json(upload, 201));
    const result = (await makeClient().uploads.upload(
      new Blob(['x']),
      undefined as unknown as { uploadable_id: number; uploadable_type: string },
      { dryRun: true },
    )) as DryRunResult<Upload>;
    expect(spy.calls).toHaveLength(0);
    expect(result.checks[1]!.ok).toBe(false);
  });
});

describe('UploadsResource — the stale option outside update', () => {
  afterEach(() => clearFetch());

  it('refuses expectedUpdatedAt on upload and delete instead of ignoring it', async () => {
    const spy = stubFetch(() => json(upload, 201));
    const uploaded = (await makeClient()
      .uploads.upload(new Blob(['x']), { uploadable_id: 5, uploadable_type: 'Article' }, { expectedUpdatedAt: 't' })
      .catch((e: unknown) => e)) as HuduError;
    expect(uploaded).toBeInstanceOf(HuduConfigError);
    expect(uploaded.code).toBe('CONFIG_ERROR');
    expect(uploaded.category).toBe('validation');
    expect(uploaded.message).toContain('uploads.upload');
    expect(uploaded.message).toContain('update (PUT) only');

    const deleted = (await makeClient().uploads.delete(3, { expectedUpdatedAt: 't' }).catch((e: unknown) => e)) as HuduError;
    expect(deleted).toBeInstanceOf(HuduConfigError);
    expect(deleted.message).toContain('uploads.delete');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('UploadsResource — dry-run impact equals the executed audit impact', () => {
  afterEach(() => clearFetch());

  it('uploads.upload: the executed audit event reports the same impact as the dry-run', async () => {
    const events: AuditEvent[] = [];
    const client = makeAuditedClient(events);
    stubFetch(() => json(upload, 201));
    const dry = (await client.uploads.upload(
      new Blob(['x']),
      { uploadable_id: 5, uploadable_type: 'Article' },
      { dryRun: true },
    )) as DryRunResult<Upload>;
    await client.uploads.upload(new Blob(['x']), { uploadable_id: 5, uploadable_type: 'Article' });
    expect(events).toHaveLength(1);
    expect(events[0]!.dryRun).toBe(false);
    expect(events[0]!.impact).toEqual(dry.impact);
    // Honest: DELETE /uploads/{id} exists, so the uploaded file can be removed.
    expect(dry.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('uploads.delete: the executed audit event reports the same impact as the dry-run', async () => {
    const events: AuditEvent[] = [];
    const client = makeAuditedClient(events);
    stubFetch(() => empty(204));
    const dry = (await client.uploads.delete(3, { dryRun: true })) as DryRunResult<void>;
    await client.uploads.delete(3);
    expect(events[0]!.impact).toEqual(dry.impact);
    // Destructive, and uploads expose no archive/restore endpoint.
    expect(dry.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });
});
