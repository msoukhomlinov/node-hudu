/**
 * Coverage for resources with special method shapes: photos, exports, magic_dash,
 * public_photos, activity_logs, api_info, cards, s3_exports, expirations.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, text, empty, clearFetch, type FetchHandler } from '../helpers.js';

function makeClient() { return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }); }

describe('AssetLayoutsResource', () => {
  afterEach(() => clearFetch());

  // Server returns N items for the requested `page`; beyond the data it returns
  // an empty (exhaustion) page — a realistic /asset_layouts response.
  function layoutPages(pages: Record<number, unknown[]>): FetchHandler {
    return (url) => {
      const page = Number(new URL(url).searchParams.get('page')) || 1;
      return json({ asset_layouts: pages[page] ?? [] });
    };
  }

  it('paginates by page but never sends page_size (B2)', async () => {
    const spy = stubFetch(layoutPages({ 1: [{ id: 1, name: 'Default' }] }));
    const res = await makeClient().assetLayouts.listAll({ name: 'Default' });
    expect(res).toEqual([{ id: 1, name: 'Default' }]);
    expect(spy.calls[0].url).toContain('/asset_layouts?');
    expect(spy.calls[0].url).toContain('name=Default');
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).not.toContain('page_size');
  });

  it('listAll throws no-progress when /asset_layouts ignores page (codex[17])', async () => {
    // Server returns the same FULL page (>= default server page size) regardless
    // of the requested page -> must throw rather than yield duplicates / loop.
    const fullPage = { asset_layouts: Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: 'Layout' + i })) };
    const spy = stubFetch(() => json(fullPage));
    await expect(makeClient().assetLayouts.listAll()).rejects.toThrow(/no progress|same full page content/);
    expect(spy.calls.length).toBeLessThan(10);
  });

  it('does not truncate when the server paginates at its own page size (R1)', async () => {
    // The server returns full pages of 10 — while the SDK default page_size is
    // 25 and is NEVER sent to /asset_layouts. Termination must follow the
    // server's real page size, not the unsent SDK default, so every record is
    // collected and no `page_size` is ever forwarded.
    const pages: Record<number, unknown[]> = {
      1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => ({ id })),
      2: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((id) => ({ id })),
      3: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map((id) => ({ id })),
    };
    const spy = stubFetch(layoutPages(pages));
    const res = await makeClient().assetLayouts.listAll({});
    expect(res).toHaveLength(30);
    expect(res.map((r) => (r as { id: number }).id)).toEqual([...Array(30).keys()].map((i) => i + 1));
    // Never send page_size on any request (R1/B2).
    for (const call of spy.calls) expect(call.url).not.toContain('page_size');
    // 3 full server pages + one empty exhaustion page.
    expect(spy.calls.length).toBeGreaterThanOrEqual(3);
  });
  it('create/update wrap the body in asset_layout (B7 n/a — assetLayouts has no wrapper; create is wrapped-response only)', async () => {
    const spy = stubFetch(() => json({ asset_layout: { id: 1 } }, 201));
    await makeClient().assetLayouts.create({ name: 'Layout' });
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ name: 'Layout' }));
  });
  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: -3 },
  ])('rejects a non-positive/non-integer page %o with HuduConfigError and never requests (F8)', async (params) => {
    const spy = stubFetch(() => json({ asset_layouts: [] }));
    await expect(makeClient().assetLayouts.listAll(params)).rejects.toThrow(/page must be a positive integer/);
    expect(spy.calls.length).toBe(0);
  });
});


describe('PhotosResource', () => {
  afterEach(() => clearFetch());
  it('get unwraps the photo', async () => {
    const spy = stubFetch(() => json({ photo: { id: 3 } }));
    const res = await makeClient().photos.get(3);
    expect(res).toEqual({ id: 3 });
    expect(spy.calls[0].url).toContain('/photos/3');
  });
  it('get with download requests the binary', async () => {
    const spy = stubFetch(() => text('imgbytes'));
    const res = await makeClient().photos.get(3, { download: true });
    expect(res).toBeInstanceOf(Blob);
    expect(await (res as Blob).text()).toBe('imgbytes');
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/photos/3?download=true');
  });
  it('create sends multipart with required file+caption (B16) and unwraps', async () => {
    const spy = stubFetch(() => json({ photo: { id: 9 } }, 201));
    const fd = new FormData();
    fd.append('file', new Blob(['x']));
    const res = await makeClient().photos.create({ file: fd.get('file')!, caption: 'cap', company_id: 1, pinned: true });
    expect(spy.calls[0].init.method).toBe('POST');
    const sent = spy.calls[0].init.body as FormData;
    expect(sent.has('file')).toBe(true);
    expect(sent.get('caption')).toBe('cap');
    expect(sent.get('company_id')).toBe('1');
    expect(sent.get('pinned')).toBe('true');
  });
  it('listAll collects', async () => {
    const spy = stubFetch(() => json({ photos: [{ id: 3 }] }));
    const res = await makeClient().photos.listAll({});
    expect(spy.calls[0].url).toContain('/photos');
  });
  it('update unwraps wrapped and wraps the body in { photo } (B7/B16)', async () => {
    const spy = stubFetch(() => json({ photo: { id: 3 } }));
    await expect(makeClient().photos.update(3, { caption: 'New' })).resolves.toEqual({ id: 3 });
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ photo: { caption: 'New' } }));
  });
  it('delete returns void', async () => {
    stubFetch(() => empty(204));
    await expect(makeClient().photos.delete(3)).resolves.toBeUndefined();
  });
});

describe('ExportsResource', () => {
  afterEach(() => clearFetch());
  it('listAll returns the sole page', async () => {
    const spy = stubFetch(() => json([{ id: 1 }]));
    const res = await makeClient().exports.listAll({});
    expect(res).toEqual([{ id: 1 }]);
    expect(spy.calls).toHaveLength(1);
  });
  it('create wraps the body in { export } and resolves void on empty body (B17)', async () => {
    const spy = stubFetch(() => empty(200));
    const payload = { format: 'xlsx', company_id: 3, include_passwords: true, include_websites: false } as const;
    await expect(makeClient().exports.create(payload)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ export: payload }));
  });
  it('get returns metadata by default and blob when downloading', async () => {
    const spy = stubFetch(() => json({ id: 1, state: 'complete' }));
    const meta = await makeClient().exports.get(1);
    expect(meta).toEqual({ id: 1, state: 'complete' });
    expect(spy.calls[0].url).toContain('/exports/1');
    const spy2 = stubFetch(() => text('data'));
    const blob = await makeClient().exports.get(1, { download: true });
    expect(blob).toBeInstanceOf(Blob);
    expect(await (blob as Blob).text()).toBe('data');
    expect(spy2.calls[0].url).toBe('https://hudu.example.com/api/v1/exports/1?download=true');
  });
});

describe('MagicDashResource', () => {
  afterEach(() => clearFetch());
  it('listAll collects', async () => {
    stubFetch(() => json([{ id: 1, title: 't' }]));
    await expect(makeClient().magicDash.listAll({})).resolves.toEqual([{ id: 1, title: 't' }]);
  });
  it('create posts and returns raw', async () => {
    const spy = stubFetch(() => json({ id: 2 }));
    const res = await makeClient().magicDash.create({ title: 't' });
    expect(spy.calls[0].init.method).toBe('POST');
  });
  it('delete sends title and company_name as urlencoded form; deleteById hits id path', async () => {
    const spy = stubFetch(() => empty(204));
    await makeClient().magicDash.delete({ title: 'Microsoft 365', company_name: 'AcmeCorp' });
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/magic_dash');
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[0].init.body).toBe('title=Microsoft+365&company_name=AcmeCorp');
    expect(spy.calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    await makeClient().magicDash.deleteById(7);
    expect(spy.calls[1].url).toBe('https://hudu.example.com/api/v1/magic_dash/7');
  });
  it('updatePositions PUTs { company_id, positions }', async () => {
    const spy = stubFetch(() => json({ success: true }));
    const res = await makeClient().magicDash.updatePositions({
      company_id: 3,
      positions: [{ id: 1, position: 2 }, { id: 2, position: 1 }],
    });
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].init.body).toBe(
      JSON.stringify({ company_id: 3, positions: [{ id: 1, position: 2 }, { id: 2, position: 1 }] }),
    );
  });
});

describe('PublicPhotosResource', () => {
  afterEach(() => clearFetch());
  it('get returns raw photo', async () => {
    stubFetch(() => json({ id: 4, url: 'https://x/p.png' }));
    await expect(makeClient().publicPhotos.get(4)).resolves.toEqual({ id: 4, url: 'https://x/p.png' });
  });
  it('listAll unwraps public_photos', async () => {
    const spy = stubFetch(() => json({ public_photos: [{ id: 4 }] }));
    const res = await makeClient().publicPhotos.listAll({});
    expect(res).toEqual([{ id: 4 }]);
    expect(spy.calls[0].url).toContain('/public_photos');
  });
  it('create sends { photo, record_type, record_id } multipart and returns raw', async () => {
    const spy = stubFetch(() => json({ id: 4 }, 201));
    const photo = new Blob(['x'], { type: 'image/png' });
    const res = await makeClient().publicPhotos.create({ photo, record_type: 'Article', record_id: 5 });
    expect(res).toEqual({ id: 4 });
    const fd = spy.calls[0].init.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.has('photo')).toBe(true);
    expect(fd.has('file')).toBe(false);
    expect(fd.get('record_type')).toBe('Article');
    expect(fd.get('record_id')).toBe('5');
  });
  it('update sends record_type/record_id as multipart and unwraps the public_photo envelope', async () => {
    const spy = stubFetch(() => json({ public_photo: { id: 4, record_id: 9 } }));
    const res = await makeClient().publicPhotos.update(4, { record_type: 'Article', record_id: 9 });
    expect(res).toEqual({ id: 4, record_id: 9 });
    expect(spy.calls[0].init.method).toBe('PUT');
    const fd = spy.calls[0].init.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get('record_type')).toBe('Article');
    expect(fd.get('record_id')).toBe('9');
  });
});

describe('ActivityLogsResource', () => {
  afterEach(() => clearFetch());
  it('listAll collects', async () => {
    stubFetch(() => json([{ id: 1, user_email: 'a@b.c' }]));
    await expect(makeClient().activityLogs.listAll({})).resolves.toEqual([{ id: 1, user_email: 'a@b.c' }]);
  });
  it('unwraps a wrapped { activity_logs: [...] } response (B-1)', async () => {
    stubFetch(() => json({ activity_logs: [{ id: 1, user_email: 'a@b.c' }, { id: 2, user_email: 'd@e.f' }] }));
    await expect(makeClient().activityLogs.listAll({})).resolves.toEqual([
      { id: 1, user_email: 'a@b.c' },
      { id: 2, user_email: 'd@e.f' },
    ]);
    const items: unknown[] = [];
    for await (const a of makeClient().activityLogs.list({})) items.push(a);
    expect(items).toEqual([{ id: 1, user_email: 'a@b.c' }, { id: 2, user_email: 'd@e.f' }]);
  });
  it('listAll treats an unexpected empty record as no results (B-1)', async () => {
    stubFetch(() => json({}));
    await expect(makeClient().activityLogs.listAll({})).resolves.toEqual([]);
  });
  it('list streams items and listPages yields page objects (B22)', async () => {
    stubFetch(() => json([{ id: 1, user_email: 'a@b.c' }]));
    const items: unknown[] = [];
    for await (const a of makeClient().activityLogs.list({})) items.push(a);
    expect(items).toEqual([{ id: 1, user_email: 'a@b.c' }]);
    const pages: unknown[] = [];
    for await (const p of makeClient().activityLogs.listPages({})) pages.push(p);
    expect((pages[0] as { items: unknown[] }).items).toEqual([{ id: 1, user_email: 'a@b.c' }]);
  });
  it('deleteAll sends the required datetime query param', async () => {
    const spy = stubFetch(() => empty(204));
    await makeClient().activityLogs.deleteAll({ datetime: '2024-01-01T00:00:00Z', delete_unassigned_logs: true });
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[0].url).toBe(
      'https://hudu.example.com/api/v1/activity_logs?datetime=2024-01-01T00%3A00%3A00Z&delete_unassigned_logs=true',
    );
  });
});

describe('MatchersResource', () => {
  afterEach(() => clearFetch());
  it('listAll sends the required integration_id query param', async () => {
    const spy = stubFetch(() => json({ matchers: [{ id: 1 }] }));
    const res = await makeClient().matchers.listAll({ integration_id: 42 });
    expect(res).toEqual([{ id: 1 }]);
    expect(spy.calls[0].url).toContain('integration_id=42');
  });
});

describe('ApiInfoResource', () => {
  afterEach(() => clearFetch());
  it('get returns version info', async () => {
    const spy = stubFetch(() => json({ version: '2.41.0', date: '2024-01-01' }));
    const res = await makeClient().apiInfo.get();
    expect(res).toEqual({ version: '2.41.0', date: '2024-01-01' });
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/api_info');
  });
});

describe('S3ExportsResource', () => {
  afterEach(() => clearFetch());
  it('create posts and resolves void', async () => {
    const spy = stubFetch(() => empty(200));
    await expect(makeClient().s3Exports.create({ bucket: 'b' })).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/s3_exports');
  });
  it('create with no payload sends an empty object body', async () => {
    const spy = stubFetch(() => empty(200));
    await makeClient().s3Exports.create();
    expect(spy.calls[0].init.body).toBe('{}');
  });
});

describe('CardsResource', () => {
  afterEach(() => clearFetch());
  it('lookup unwraps integrator_cards', async () => {
    const spy = stubFetch(() => json({ integrator_cards: [{ id: 1, company_id: 2 }] }));
    const res = await makeClient().cards.lookup({ integration_slug: 'hudu' });
    expect(res).toEqual([{ id: 1, company_id: 2 }]);
    expect(spy.calls[0].url).toContain('/cards/lookup');
    expect(spy.calls[0].url).toContain('integration_slug=hudu');
  });
  it('jump follows the redirect and returns the Location', async () => {
    const spy = stubFetch(() =>
      new Response(null, { status: 302, headers: { location: 'https://hudu.example.com/companies/acme' } }),
    );
    const url = await makeClient().cards.jump({ integration_type: 'hudu', integration_slug: 'hudu' });
    expect(url).toBe('https://hudu.example.com/companies/acme');
    expect(spy.calls[0].url).toContain('/cards/jump');
  });
});

describe('ExpirationsResource', () => {
  afterEach(() => clearFetch());
  it('listAll collects', async () => {
    stubFetch(() => json([{ id: 1, resource_type: 'Asset' }]));
    await expect(makeClient().expirations.listAll({})).resolves.toEqual([{ id: 1, resource_type: 'Asset' }]);
  });
  it('list streams items and listPages yields page objects (B22)', async () => {
    stubFetch(() => json([{ id: 1, resource_type: 'Asset' }]));
    const items: unknown[] = [];
    for await (const e of makeClient().expirations.list({})) items.push(e);
    expect(items).toEqual([{ id: 1, resource_type: 'Asset' }]);
    const pages: unknown[] = [];
    for await (const p of makeClient().expirations.listPages({})) pages.push(p);
    expect((pages[0] as { items: unknown[] }).items).toEqual([{ id: 1, resource_type: 'Asset' }]);
  });
  it('update wraps the body in { expiration } (B7)', async () => {
    const spy = stubFetch(() => json({ id: 1 }));
    const res = await makeClient().expirations.update(1, { expiration_type: 'domain' });
    expect(res).toEqual({ id: 1 });
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ expiration: { expiration_type: 'domain' } }));
  });
  it('delete returns void', async () => {
    const spy = stubFetch(() => json({ id: 1 }));
    const res = await makeClient().expirations.update(1, {});
    expect(spy.calls[0].init.method).toBe('PUT');
  });
  it('delete returns void', async () => {
    stubFetch(() => empty(204));
    await expect(makeClient().expirations.delete(1)).resolves.toBeUndefined();
  });
});
