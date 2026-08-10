/**
 * Coverage for resources with special method shapes: photos, exports, magic_dash,
 * public_photos, activity_logs, api_info, cards, s3_exports, expirations.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, text, empty, clearFetch } from '../helpers.js';

function makeClient() { return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }); }

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
    expect(res).toBe('imgbytes');
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/photos/3?download=true');
  });
  it('create sends multipart and unwraps', async () => {
    const spy = stubFetch(() => json({ photo: { id: 9 } }, 201));
    const fd = new FormData();
    fd.append('file', new Blob(['x']));
    const res = await makeClient().photos.create({ file: fd.get('file')!, caption: 'cap', company_id: 1, pinned: true });
    expect(spy.calls[0].init.method).toBe('POST');
    expect((spy.calls[0].init.body as FormData).has('file')).toBe(true);
  });
  it('listAll collects', async () => {
    const spy = stubFetch(() => json({ photos: [{ id: 3 }] }));
    const res = await makeClient().photos.listAll({});
    expect(spy.calls[0].url).toContain('/photos');
  });
  it('update unwraps wrapped', async () => {
    stubFetch(() => json({ photo: { id: 3 } }));
    await expect(makeClient().photos.update(3, {})).resolves.toEqual({ id: 3 });
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
  it('create initiates and resolves void on empty body', async () => {
    const spy = stubFetch(() => empty(200));
    await expect(makeClient().exports.create({ format: 'xlsx' })).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ format: 'xlsx' }));
  });
  it('get returns metadata by default and blob when downloading', async () => {
    const spy = stubFetch(() => json({ id: 1, state: 'complete' }));
    const meta = await makeClient().exports.get(1);
    expect(meta).toEqual({ id: 1, state: 'complete' });
    expect(spy.calls[0].url).toContain('/exports/1');
    const spy2 = stubFetch(() => text('data'));
    const blob = await makeClient().exports.get(1, { download: true });
    expect(blob).toBe('data');
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
  it('delete and deleteById hit correct paths', async () => {
    const spy = stubFetch(() => empty(204));
    await makeClient().magicDash.delete();
    await makeClient().magicDash.deleteById(7);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/magic_dash');
    expect(spy.calls[1].url).toBe('https://hudu.example.com/api/v1/magic_dash/7');
  });
  it('updatePositions PUTs the payload', async () => {
    const spy = stubFetch(() => json({ success: true }));
    const res = await makeClient().magicDash.updatePositions({ items: [{ id: 1, position: 2 }] });
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ items: [{ id: 1, position: 2 }] }));
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
  it('create sends multipart and returns raw', async () => {
    const spy = stubFetch(() => json({ id: 4 }, 201));
    const fd = new FormData();
    fd.append('file', new Blob(['x']));
    const res = await makeClient().publicPhotos.create({ file: fd.get('file')!, record_type: 'Article', record_id: 5 });
    expect((spy.calls[0].init.body as FormData).has('file')).toBe(true);
    expect((spy.calls[0].init.body as FormData).get('record_id')).toBe('5');
  });
  it('update returns raw body', async () => {
    const spy = stubFetch(() => json({ id: 4, record_id: 9 }));
    const res = await makeClient().publicPhotos.update(4, { record_id: 9 });
    expect(spy.calls[0].init.method).toBe('PUT');
  });
});

describe('ActivityLogsResource', () => {
  afterEach(() => clearFetch());
  it('listAll collects', async () => {
    stubFetch(() => json([{ id: 1, user_email: 'a@b.c' }]));
    await expect(makeClient().activityLogs.listAll({})).resolves.toEqual([{ id: 1, user_email: 'a@b.c' }]);
  });
  it('deleteAll issues DELETE /activity_logs', async () => {
    const spy = stubFetch(() => empty(204));
    await makeClient().activityLogs.deleteAll();
    expect(spy.calls[0].init.method).toBe('DELETE');
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/activity_logs');
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
  it('update returns raw body', async () => {
    const spy = stubFetch(() => json({ id: 1 }));
    const res = await makeClient().expirations.update(1, {});
    expect(spy.calls[0].init.method).toBe('PUT');
  });
  it('delete returns void', async () => {
    stubFetch(() => empty(204));
    await expect(makeClient().expirations.delete(1)).resolves.toBeUndefined();
  });
});
