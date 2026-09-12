/**
 * PhotosResource agent-execution-layer tests: resolve (id + photoable), the bounded
 * scan cap, findByPhotoable limits, dry-run on every mutation, the stale guard and
 * correlation ids. Uses the shared mocked-fetch helper — never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError, ResolutionError } from '../../src/errors.js';
import type { AuditEvent, DryRunResult, Resolution } from '../../src/types/common.js';
import type { Photo } from '../../src/types/photo.js';
import type { Page } from '../../src/pagination.js';
import type { PhotoSummary } from '../../src/types/photo.js';
import { stubFetch, json, text, empty, clearFetch } from '../helpers.js';

function makeClient(onAudit?: (event: AuditEvent) => void) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...(onAudit ? { onAudit } : {}) });
}

const photo: Photo = {
  id: 3,
  company_id: 1,
  folder_id: 2,
  photoable_type: 'Asset',
  photoable_id: 9,
  caption: 'Front panel',
  pinned: false,
  archived: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A 25-record page (the scan page size) with unique ids and none matching. */
function fullPage(match: boolean) {
  const items = Array.from({ length: 25 }, (_, i) => ({
    ...photo,
    id: 100 + i,
    caption: `other ${i}`,
    photoable_id: match ? 9 : 999,
  }));
  return json({ photos: items });
}

describe('PhotosResource — resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ photo }));
    const res = await makeClient().photos.resolve(3);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/photos/3');
    expect(spy.calls[0]!.url).not.toContain('page=');
    expect(res?.id).toBe(3);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeClient().photos.resolve(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    const spy = stubFetch(() => json({ photos: [photo] }));
    const res = await makeClient().photos.resolve({ photoable_type: 'Asset', photoable_id: 9 });
    expect(res).toEqual({
      id: 3,
      company_id: 1,
      folder_id: 2,
      photoable_type: 'Asset',
      photoable_id: 9,
      caption: 'Front panel',
      pinned: false,
      archived: false,
      updated_at: '2026-02-01T00:00:00Z',
    });
    expect((res as PhotoSummary).created_at).toBeUndefined();
    // Two bounded vendor-filtered passes: the match, then the uniqueness proof.
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]!.url).toContain('photoable_type=Asset');
    expect(spy.calls[0]!.url).toContain('photoable_id=9');
    expect(spy.calls[0]!.url).toContain('page_size=25');
  });

  it('throws RESOLUTION_AMBIGUOUS when a record has several photos', async () => {
    stubFetch(() => json({ photos: [photo, { ...photo, id: 4, caption: 'Side panel' }] }));
    const err = (await makeClient().photos.resolve({ photoable_type: 'Asset', photoable_id: 9 }).catch((e: unknown) => e)) as HuduError;
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.category).toBe('resolution');
    expect(err.resourceIds).toEqual([3, 4]);
    expect(err.message).toContain('findByPhotoable');
  });

  it('returns PhotoSummary', async () => {
    stubFetch(() => json({ photo }));
    const summary = (await makeClient().photos.resolve(3)) as PhotoSummary;
    expect(Object.keys(summary).sort()).toEqual(
      ['archived', 'caption', 'company_id', 'folder_id', 'id', 'photoable_id', 'photoable_type', 'pinned', 'updated_at'],
    );
  });

  it('expand: true returns the full photo', async () => {
    stubFetch(() => json({ photo }));
    const full = (await makeClient().photos.resolve(3, { expand: true })) as Photo;
    expect(full).toEqual(photo);
    expect(full.created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('resolutionDetails: true reports the cost and the candidates', async () => {
    stubFetch(() => json({ photo }));
    const detail = (await makeClient().photos.resolve(3, { resolutionDetails: true })) as Resolution<PhotoSummary>;
    expect(detail.resolutionCost).toBe('direct');
    expect(detail.scanTruncated).toBe(false);
    expect(detail.scanned).toBe(1);
    expect(detail.candidates).toEqual([{ id: 3, label: 'photo 3 (Front panel)' }]);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap is reached', async () => {
    // Every page is full, so hasMore stays true and the 4-page cap stops the scan.
    const spy = stubFetch(() => fullPage(false));
    const err = (await makeClient().photos.resolve({ photoable_type: 'Asset', photoable_id: 9 }).catch((e: unknown) => e)) as HuduError;
    expect(ResolutionError).toBeDefined();
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.resourceIds).toEqual([9]);
    expect(spy.calls).toHaveLength(4);
  });

  it('returns null after a complete scan, not for a truncated one', async () => {
    stubFetch(() => json({ photos: [{ ...photo, id: 77, photoable_id: 555 }] }));
    await expect(makeClient().photos.resolve({ photoable_type: 'Asset', photoable_id: 9 })).resolves.toBeNull();
  });

  it('rejects an identifier kind the vendor cannot support', async () => {
    stubFetch(() => json({ photos: [] }));
    await expect(makeClient().photos.resolve({ caption: 'Front panel' })).rejects.toThrow(HuduConfigError);
    await expect(makeClient().photos.resolve('front-panel')).rejects.toThrow(/accepts an id/);
  });
});

describe('PhotosResource — findByPhotoable', () => {
  afterEach(() => clearFetch());

  it('returns the photos of the record', async () => {
    const spy = stubFetch(() => json({ photos: [photo] }));
    const res = await makeClient().photos.findByPhotoable('Asset', 9);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe(3);
    expect(spy.calls[0]!.url).toContain('page_size=25');
    expect(spy.calls[0]!.url).toContain('photoable_id=9');
  });

  it('returns an empty array when the record has no photos', async () => {
    stubFetch(() => json({ photos: [] }));
    await expect(makeClient().photos.findByPhotoable('Asset', 9)).resolves.toEqual([]);
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = stubFetch(() => json({ photos: [photo] }));
    await makeClient().photos.findByPhotoable('Asset', 9, { limit: 100 });
    expect(spy.calls[0]!.url).toContain('page_size=100');
    await expect(makeClient().photos.findByPhotoable('Asset', 9, { limit: 101 })).rejects.toThrow(HuduConfigError);
    await expect(makeClient().photos.findByPhotoable('Asset', 9, { limit: 0 })).rejects.toThrow(HuduConfigError);
    // The rejected limits cost no request at all.
    expect(spy.calls).toHaveLength(1);
  });

  it('expand: true returns full photos', async () => {
    stubFetch(() => json({ photos: [photo] }));
    const res = await makeClient().photos.findByPhotoable('Asset', 9, { expand: true });
    expect(res[0]!.created_at).toBe('2026-01-01T00:00:00Z');
  });
});

describe('PhotosResource — primitives', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped photos record', async () => {
    stubFetch(() => json({ photo }));
    await expect(makeClient().photos.get(3)).resolves.toEqual(photo);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'nope' }, 404));
    await expect(makeClient().photos.get(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the unwrapped photos list', async () => {
    stubFetch(() => json({ photos: [photo] }));
    const out: Photo[] = [];
    for await (const p of makeClient().photos.list({})) out.push(p);
    expect(out).toEqual([photo]);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const spy = stubFetch(() => json({ photos: [photo] }));
    await makeClient().photos.listAll({});
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toContain('page=1');
    expect(spy.calls[0]!.url).toContain('page_size=25');
  });

  it('returns the created photos record', async () => {
    const spy = stubFetch(() => json({ photo }, 201));
    const res = await makeClient().photos.create({ file: new Blob(['x']), caption: 'cap', photoable_type: 'Asset', photoable_id: 9 });
    expect(res).toEqual(photo);
    expect(spy.calls[0]!.init.method).toBe('POST');
    expect(spy.calls[0]!.init.body).toBeInstanceOf(FormData);
  });

  it('returns the updated photos record', async () => {
    stubFetch(() => json({ photo: { ...photo, caption: 'New' } }));
    await expect(makeClient().photos.update(3, { caption: 'New' })).resolves.toEqual({ ...photo, caption: 'New' });
  });

  it('unwraps the PUT response by singleKey', async () => {
    const spy = stubFetch(() => json({ photo: { ...photo, caption: 'New' } }));
    await makeClient().photos.update(3, { caption: 'New' });
    expect(spy.calls[0]!.init.body).toBe(JSON.stringify({ photo: { caption: 'New' } }));
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().photos.delete(3)).resolves.toBeUndefined();
    expect(spy.calls[0]!.init.method).toBe('DELETE');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = (await makeClient().photos.create(
      { file: new Blob(['x']), caption: 'cap' },
      { dryRun: true },
    )) as DryRunResult<Photo>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('photos.create');
    expect(result.request).toEqual({ method: 'POST', path: '/photos' });
    expect(result.checks.map((c) => c.name)).toEqual(['file-present', 'caption-present', 'photoable-pair']);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.warnings.join(' ')).toContain('cannot be promised');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = (await makeClient().photos.update(3, { caption: 'New' }, { dryRun: true })) as DryRunResult<Photo>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'PUT', path: '/photos/3' });
    expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({}));
    const result = (await makeClient().photos.delete(3, { dryRun: true })) as DryRunResult<void>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('photos.delete');
    expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  // `photos.update` is the only mutation whose plan row records staleCheck: "updated_at";
  // create/delete are "unavailable" (a create has no prior revision, a delete is bounded
  // by the explicit id and the vendor exposes no conditional delete).
  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const spy = stubFetch((_url, init) =>
      init.method === 'PUT'
        ? json({ photo: { ...photo, caption: 'New' } })
        : json({ photo: { ...photo, updated_at: 'read-now' } }),
    );
    const err = (await makeClient()
      .photos.update(3, { caption: 'New' }, { expectedUpdatedAt: 'read-then' })
      .catch((e: unknown) => e)) as HuduError;
    expect(err.code).toBe('STALE_OBJECT');
    expect(err.category).toBe('conflict');
    expect(err.operation).toBe('photos.update');
    // The guard read the record, then refused: no PUT was sent.
    expect(spy.calls.map((c) => c.init.method)).toEqual(['GET']);
  });

  it('proceeds when the pinned revision still matches', async () => {
    const spy = stubFetch((_url, init) =>
      init.method === 'PUT' ? json({ photo: { ...photo, caption: 'New' } }) : json({ photo }),
    );
    await makeClient().photos.update(3, { caption: 'New' }, { expectedUpdatedAt: photo.updated_at });
    expect(spy.calls.map((c) => c.init.method)).toEqual(['GET', 'PUT']);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const events: AuditEvent[] = [];
    const spy = stubFetch((_url, init) => (init.method === 'DELETE' ? empty(204) : json({ photo })));
    const client = makeClient((event) => events.push(event));

    await client.photos.delete(3);
    expect(events).toHaveLength(1);
    expect(events[0]!.correlationId).toMatch(UUID);
    expect(events[0]!.operation).toBe('photos.delete');
    expect(events[0]!.outcome).toBe('success');

    // 404 is not retried, so the error path costs exactly one extra request.
    spy.setHandler(() => json({ error: 'boom' }, 404));
    const err = (await client.photos.get(3).catch((e: unknown) => e)) as HuduError;
    expect(err.correlationId).toMatch(UUID);
    expect(err.operation).toBe('photos.get');
    const errorEvent = events[events.length - 1]!;
    expect(errorEvent.outcome).toBe('error');
    expect(errorEvent.correlationId).toBe(err.correlationId);
    expect(errorEvent.httpStatus).toBe(404);
  });
});


describe('PhotosResource — remaining branches', () => {
  afterEach(() => clearFetch());

  it('accepts a numeric string id and an { id } object', async () => {
    const spy = stubFetch(() => json({ photo }));
    await expect(makeClient().photos.resolve('3')).resolves.toEqual(expect.objectContaining({ id: 3 }));
    await expect(makeClient().photos.resolve({ id: 3 })).resolves.toEqual(expect.objectContaining({ id: 3 }));
    expect(spy.calls.map((c) => c.url)).toEqual([
      'https://hudu.example.com/api/v1/photos/3',
      'https://hudu.example.com/api/v1/photos/3',
    ]);
  });

  it('rejects a null identifier without issuing a request', async () => {
    const spy = stubFetch(() => json({ photo }));
    await expect(makeClient().photos.resolve(null as unknown as number)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('get with download: true returns the file blob', async () => {
    const spy = stubFetch(() => text('image-bytes'));
    const res = await makeClient().photos.get(3, { download: true });
    expect(res).toBeInstanceOf(Blob);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/photos/3?download=true');
  });

  it('listPages yields pages with their pagination metadata', async () => {
    stubFetch(() => json({ photos: [photo] }));
    const pages: Page<Photo>[] = [];
    for await (const p of makeClient().photos.listPages({})) pages.push(p);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.page).toBe(1);
    expect(pages[0]!.hasMore).toBe(false);
  });

  it('narrows the photoable lookup by folder_id', async () => {
    const spy = stubFetch(() => json({ photos: [{ ...photo, folder_id: 2 }] }));
    await makeClient().photos.resolve({ photoable_type: 'Asset', photoable_id: 9, folder_id: 2 });
    expect(spy.calls[0]!.url).toContain('folder_id=2');
    // A photo in another folder is not a match.
    stubFetch(() => json({ photos: [{ ...photo, folder_id: 3 }] }));
    await expect(makeClient().photos.resolve({ photoable_type: 'Asset', photoable_id: 9, folder_id: 2 })).resolves.toBeNull();
  });

  it('resolutionDetails reports a complete scan that found nothing', async () => {
    stubFetch(() => json({ photos: [] }));
    const detail = (await makeClient().photos.resolve(
      { photoable_type: 'Asset', photoable_id: 9 },
      { resolutionDetails: true },
    )) as Resolution<PhotoSummary>;
    expect(detail.value).toBeNull();
    expect(detail.scanTruncated).toBe(false);
    expect(detail.resolutionCost).toBe('server-filter');
  });

  it('resolutionDetails reports a photoable match with its filter cost', async () => {
    stubFetch(() => json({ photos: [photo] }));
    const detail = (await makeClient().photos.resolve(
      { photoable_type: 'Asset', photoable_id: 9 },
      { resolutionDetails: true },
    )) as Resolution<PhotoSummary>;
    expect(detail.value?.id).toBe(3);
    expect(detail.resolutionCost).toBe('server-filter');
    expect(detail.candidates).toEqual([{ id: 3, label: 'photo 3 (Front panel)' }]);
  });

  it('validates the findByPhotoable arguments', async () => {
    const spy = stubFetch(() => json({ photos: [] }));
    await expect(makeClient().photos.findByPhotoable('', 9)).rejects.toThrow(HuduConfigError);
    await expect(makeClient().photos.findByPhotoable('Asset', 1.5)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('dry-run reports a missing caption and a broken photoable pair', async () => {
    const spy = stubFetch(() => json({}));
    const missingCaption = (await makeClient().photos.create(
      { file: new Blob(['x']), caption: '' },
      { dryRun: true },
    )) as DryRunResult<Photo>;
    expect(missingCaption.checks.map((c) => c.ok)).toEqual([true, false, true]);
    const brokenPair = (await makeClient().photos.create(
      { file: new Blob(['x']), caption: 'cap', photoable_type: 'Asset' },
      { dryRun: true },
    )) as DryRunResult<Photo>;
    expect(brokenPair.checks[2]).toEqual({
      name: 'photoable-pair',
      ok: false,
      detail: 'photoable_type and photoable_id must be supplied together',
    });
    expect(spy.calls).toHaveLength(0);
  });

  it('creates a photo that is not attached to a photoable', async () => {
    const spy = stubFetch(() => json({ photo }, 201));
    await makeClient().photos.create({ file: new Blob(['x']), caption: 'cap', company_id: 1 });
    expect(spy.calls[0]!.init.method).toBe('POST');
    const fd = spy.calls[0]!.init.body as FormData;
    expect(fd.get('company_id')).toBe('1');
    expect(fd.has('photoable_id')).toBe(false);
  });
});

describe('PhotosResource — the stale option outside update', () => {
  afterEach(() => clearFetch());

  it('refuses expectedUpdatedAt on create and delete instead of ignoring it', async () => {
    const spy = stubFetch(() => json({ photo }, 201));
    const created = (await makeClient()
      .photos.create({ file: new Blob(['x']), caption: 'cap' }, { expectedUpdatedAt: 't' })
      .catch((e: unknown) => e)) as HuduError;
    expect(created).toBeInstanceOf(HuduConfigError);
    expect(created.code).toBe('CONFIG_ERROR');
    expect(created.category).toBe('validation');
    expect(created.message).toContain('photos.create');
    expect(created.message).toContain('update (PUT) only');

    const deleted = (await makeClient()
      .photos.delete(3, { expectedUpdatedAt: 't' })
      .catch((e: unknown) => e)) as HuduError;
    expect(deleted).toBeInstanceOf(HuduConfigError);
    expect(deleted.message).toContain('photos.delete');

    // A dry-run must not claim a guard that can never run either.
    const dry = (await makeClient()
      .photos.delete(3, { dryRun: true, expectedUpdatedAt: 't' })
      .catch((e: unknown) => e)) as HuduError;
    expect(dry).toBeInstanceOf(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('PhotosResource — dry-run impact equals the executed audit impact', () => {
  afterEach(() => clearFetch());

  it('photos.create: the executed audit event reports the same impact as the dry-run', async () => {
    const events: AuditEvent[] = [];
    const client = makeClient((event) => events.push(event));
    stubFetch(() => json({ photo }, 201));
    const dry = (await client.photos.create({ file: new Blob(['x']), caption: 'cap' }, { dryRun: true })) as DryRunResult<Photo>;
    await client.photos.create({ file: new Blob(['x']), caption: 'cap' });
    // The dry-run path builds its result locally and never reaches the transport, so only the
    // EXECUTED call emits an audit event. Its impact must equal the dry-run's for the same input.
    expect(events).toHaveLength(1);
    expect(events[0]!.dryRun).toBe(false);
    expect(events[0]!.impact).toEqual(dry.impact);
    // Honest either way: DELETE /photos/{id} exists, so the created row can be removed.
    expect(dry.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('photos.update: the executed audit event reports the same impact as the dry-run', async () => {
    const events: AuditEvent[] = [];
    const client = makeClient((event) => events.push(event));
    stubFetch(() => json({ photo }));
    const dry = (await client.photos.update(3, { caption: 'New' }, { dryRun: true })) as DryRunResult<Photo>;
    await client.photos.update(3, { caption: 'New' });
    expect(events[0]!.impact).toEqual(dry.impact);
    // Reversible: the prior field values can be written back with another PUT.
    expect(dry.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('photos.delete: the executed audit event reports the same impact as the dry-run', async () => {
    const events: AuditEvent[] = [];
    const client = makeClient((event) => events.push(event));
    stubFetch(() => empty(204));
    const dry = (await client.photos.delete(3, { dryRun: true })) as DryRunResult<void>;
    await client.photos.delete(3);
    expect(events[0]!.impact).toEqual(dry.impact);
    // Destructive, and photos expose no undelete/restore endpoint.
    expect(dry.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });
});
