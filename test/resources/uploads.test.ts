/**
 * UploadsResource tests incl. multipart upload.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HuduClient } from '../../src/client.js';
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
