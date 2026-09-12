/**
 * PublicPhotosResource agent-execution-layer tests: resolve (id + a bounded
 * client scan over the record pair, since the endpoint declares no filters),
 * dry-run on the multipart writers and correlation ids.
 * Uses the shared mocked-fetch helper — never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError } from '../../src/errors.js';
import type { AuditEvent, DryRunResult, Resolution } from '../../src/types/common.js';
import type { PublicPhoto } from '../../src/types/public_photo.js';
import { stubFetch, json, text, empty, clearFetch } from '../helpers.js';

function makeClient(onAudit?: (event: AuditEvent) => void) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...(onAudit ? { onAudit } : {}) });
}

const photo: PublicPhoto = {
  id: 'abc123',
  numeric_id: 4,
  url: '/public_photo/abc123',
  record_type: 'Article',
  record_id: 5,
  file_name: 'panel.png',
  file_size: 1024,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A 25-record page (the scan page size); the cap is one page for this resolve. */
function otherRecordPage() {
  const items = Array.from({ length: 25 }, (_, i) => ({ ...photo, id: `other${i}`, numeric_id: 100 + i, record_id: 999 }));
  return json({ public_photos: items });
}

describe('PublicPhotosResource — resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ public_photo: photo }));
    const res = await makeClient().publicPhotos.resolve(4);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/public_photos/4');
    expect(res).toEqual(photo);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeClient().publicPhotos.resolve(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('finds the photo by a bounded client scan over the record pair', async () => {
    const spy = stubFetch(() => json({ public_photos: [photo] }));
    const res = await makeClient().publicPhotos.resolve({ record_type: 'Article', record_id: 5 });
    expect(res).toEqual(photo);
    // Exactly one bounded page is read (the endpoint IS paginated but filters nothing).
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toContain('page=1');
    expect(spy.calls[0]!.url).toContain('page_size=25');
  });

  it('returns null after a complete scan', async () => {
    stubFetch(() => json({ public_photos: [{ ...photo, id: 'z', numeric_id: 9, record_id: 999 }] }));
    await expect(makeClient().publicPhotos.resolve({ record_type: 'Article', record_id: 5 })).resolves.toBeNull();
  });

  it('throws RESOLUTION_TRUNCATED when the page cap stops the scan before the data ran out', async () => {
    const spy = stubFetch(() => otherRecordPage());
    const err = (await makeClient()
      .publicPhotos.resolve({ record_type: 'Article', record_id: 5 })
      .catch((e: unknown) => e)) as HuduError;
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.resourceIds).toEqual([5]);
    // One bounded page only — never a full scan of the account.
    expect(spy.calls).toHaveLength(1);
  });

  it('resolutionDetails: true reports the scan cost', async () => {
    stubFetch(() => json({ public_photos: [photo] }));
    const detail = (await makeClient().publicPhotos.resolve(
      { record_type: 'Article', record_id: 5 },
      { resolutionDetails: true },
    )) as Resolution<PublicPhoto>;
    expect(detail.resolutionCost).toBe('client-scan');
    expect(detail.scanTruncated).toBe(false);
    expect(detail.candidates).toEqual([{ id: 4, label: 'public_photo abc123 (panel.png)' }]);
  });

  it('rejects an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json({ public_photos: [] }));
    await expect(makeClient().publicPhotos.resolve({ file_name: 'panel.png' })).rejects.toThrow(HuduConfigError);
    await expect(makeClient().publicPhotos.resolve({})).rejects.toThrow(/accepts an id/);
    await expect(makeClient().publicPhotos.resolve('')).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('PublicPhotosResource — plan rows', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped public_photos record', async () => {
    stubFetch(() => json({ public_photo: photo }));
    await expect(makeClient().publicPhotos.get(4)).resolves.toEqual(photo);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'nope' }, 404));
    await expect(makeClient().publicPhotos.get(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the unwrapped public_photos list', async () => {
    stubFetch(() => json({ public_photos: [photo] }));
    const out: PublicPhoto[] = [];
    for await (const p of makeClient().publicPhotos.list({})) out.push(p);
    expect(out).toEqual([photo]);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const spy = stubFetch(() => json({ public_photos: [photo] }));
    await makeClient().publicPhotos.listAll({});
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toContain('page=1');
    expect(spy.calls[0]!.url).toContain('page_size=25');
  });

  it('returns the created public_photos record', async () => {
    const spy = stubFetch(() => json(photo, 201));
    const res = await makeClient().publicPhotos.create({ photo: new Blob(['x']), record_type: 'Article', record_id: 5 });
    expect(res).toEqual(photo);
    expect(spy.calls[0]!.init.method).toBe('POST');
    const fd = spy.calls[0]!.init.body as FormData;
    expect(fd.get('record_type')).toBe('Article');
    expect(fd.get('record_id')).toBe('5');
    expect(fd.has('photo')).toBe(true);
  });

  it('returns the updated public_photos record', async () => {
    stubFetch(() => json({ public_photo: { ...photo, record_id: 9 } }));
    await expect(makeClient().publicPhotos.update(4, { record_type: 'Article', record_id: 9 })).resolves.toEqual({
      ...photo,
      record_id: 9,
    });
  });

  it('unwraps the PUT response by singleKey', async () => {
    stubFetch(() => json({ public_photo: { ...photo, record_id: 9 } }));
    const res = await makeClient().publicPhotos.update(4, { record_type: 'Article', record_id: 9 });
    expect(res.record_id).toBe(9);
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = (await makeClient().publicPhotos.create(
      { photo: new Blob(['x']), record_type: 'Article', record_id: 5 },
      { dryRun: true },
    )) as DryRunResult<PublicPhoto>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('public_photos.create');
    expect(result.request).toEqual({ method: 'POST', path: '/public_photos' });
    expect(result.checks.map((c) => c.name)).toEqual(['photo-present', 'record-named']);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.warnings.join(' ')).toContain('cannot be promised');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = (await makeClient().publicPhotos.update(
      4,
      { record_type: 'Article', record_id: 9 },
      { dryRun: true },
    )) as DryRunResult<PublicPhoto>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'PUT', path: '/public_photos/4' });
    expect(result.target).toEqual({ resource: 'public_photos', ids: [4] });
    expect(result.checks.map((c) => c.name)).toEqual(['target-identifier', 'record-named']);
  });

  it('dry-run reports the failed checks instead of inventing a pass', async () => {
    const spy = stubFetch(() => json({}));
    const result = (await makeClient().publicPhotos.create(
      {} as unknown as { photo: Blob; record_type: string; record_id: number },
      { dryRun: true },
    )) as DryRunResult<PublicPhoto>;
    expect(spy.calls).toHaveLength(0);
    expect(result.checks.map((c) => c.ok)).toEqual([false, false]);
    expect(result.checks[1]!.detail).toContain('required');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const events: AuditEvent[] = [];
    const client = makeClient((event) => events.push(event));
    const spy = stubFetch(() => json({ public_photo: photo }));
    await client.publicPhotos.update(4, { record_type: 'Article', record_id: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]!.correlationId).toMatch(UUID);
    expect(events[0]!.operation).toBe('public_photos.update');
    expect(events[0]!.outcome).toBe('success');

    spy.setHandler(() => json({ error: 'nope' }, 404));
    const err = (await client.publicPhotos.get(404).catch((e: unknown) => e)) as HuduError;
    expect(err.correlationId).toMatch(UUID);
    expect(err.operation).toBe('public_photos.get');
    const errorEvent = events[events.length - 1]!;
    expect(errorEvent.outcome).toBe('error');
    expect(errorEvent.correlationId).toBe(err.correlationId);

    spy.setHandler(() => empty(200));
    await client.publicPhotos.create({ photo: new Blob(['x']), record_type: 'Article', record_id: 5 });
    const createEvent = events[events.length - 1]!;
    expect(createEvent.operation).toBe('public_photos.create');
    expect(createEvent.effect).toBe('write');
    expect(createEvent.correlationId).toMatch(UUID);
  });
});


describe('PublicPhotosResource — remaining branches', () => {
  afterEach(() => clearFetch());

  it('accepts the slug id, an { id } object and a null rejection', async () => {
    const spy = stubFetch(() => json({ public_photo: photo }));
    await expect(makeClient().publicPhotos.resolve('abc123')).resolves.toEqual(photo);
    await expect(makeClient().publicPhotos.resolve({ id: 'abc123' })).resolves.toEqual(photo);
    await expect(makeClient().publicPhotos.resolve({ id: 4 })).resolves.toEqual(photo);
    expect(spy.calls.map((c) => c.url)).toEqual([
      'https://hudu.example.com/api/v1/public_photos/abc123',
      'https://hudu.example.com/api/v1/public_photos/abc123',
      'https://hudu.example.com/api/v1/public_photos/4',
    ]);
    await expect(makeClient().publicPhotos.resolve(null as unknown as number)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(3);
  });

  it('get with download: true returns the file blob', async () => {
    const spy = stubFetch(() => text('png-bytes'));
    const res = await makeClient().publicPhotos.get(4, { download: true });
    expect(res).toBeInstanceOf(Blob);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/public_photos/4?download=true');
  });

  it('listPages and a no-arg list keep their defaults', async () => {
    stubFetch(() => json({ public_photos: [photo] }));
    const pages: unknown[] = [];
    for await (const p of makeClient().publicPhotos.listPages()) pages.push(p);
    expect(pages).toHaveLength(1);
    stubFetch(() => json({ public_photos: [photo] }));
    const out: PublicPhoto[] = [];
    for await (const p of makeClient().publicPhotos.list()) out.push(p);
    expect(out).toEqual([photo]);
    stubFetch(() => json({ public_photos: [photo] }));
    await expect(makeClient().publicPhotos.listAll()).resolves.toEqual([photo]);
  });

  it('resolutionDetails: true reports the direct fetch cost', async () => {
    stubFetch(() => json({ public_photo: photo }));
    const detail = (await makeClient().publicPhotos.resolve(4, { resolutionDetails: true })) as Resolution<PublicPhoto>;
    expect(detail.resolutionCost).toBe('direct');
    expect(detail.candidates).toEqual([{ id: 4, label: 'public_photo abc123' }]);
  });

  it('dry-run reports the failed checks for both multipart writers', async () => {
    const spy = stubFetch(() => json({}));
    const created = (await makeClient().publicPhotos.create(
      { photo: undefined, record_type: '', record_id: 0 } as unknown as { photo: Blob; record_type: string; record_id: number },
      { dryRun: true },
    )) as DryRunResult<PublicPhoto>;
    expect(created.checks).toEqual([
      { name: 'photo-present', ok: false, detail: 'no image file was supplied' },
      { name: 'record-named', ok: false, detail: 'record_type/record_id missing (both are required)' },
    ]);
    const updated = (await makeClient().publicPhotos.update(
      4,
      {} as unknown as { record_type: string; record_id: number },
      { dryRun: true },
    )) as DryRunResult<PublicPhoto>;
    expect(updated.checks.map((c) => c.ok)).toEqual([true, false]);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('PublicPhotosResource — the stale option outside update', () => {
  afterEach(() => clearFetch());

  it('refuses expectedUpdatedAt on create and update instead of ignoring it', async () => {
    const spy = stubFetch(() => json(photo, 201));
    const created = (await makeClient()
      .publicPhotos.create({ photo: new Blob(['x']), record_type: 'Article', record_id: 5 }, { expectedUpdatedAt: 't' })
      .catch((e: unknown) => e)) as HuduError;
    expect(created).toBeInstanceOf(HuduConfigError);
    expect(created.code).toBe('CONFIG_ERROR');
    expect(created.category).toBe('validation');
    expect(created.message).toContain('public_photos.create');
    expect(created.message).toContain('update (PUT) only');

    const updated = (await makeClient()
      .publicPhotos.update(4, { record_type: 'Article', record_id: 9 }, { expectedUpdatedAt: 't' })
      .catch((e: unknown) => e)) as HuduError;
    expect(updated).toBeInstanceOf(HuduConfigError);
    expect(updated.message).toContain('public_photos.update');
    expect(spy.calls).toHaveLength(0);
  });
});
