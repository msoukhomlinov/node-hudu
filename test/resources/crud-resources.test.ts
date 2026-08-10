/**
 * Coverage for standard CRUD resources (get / listAll / create / update / delete).
 * Uses mock envelopes derived from each resource's configured keys (see ARCHITECTURE §12).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

type CreateKind = 'raw' | 'wrapped';

interface ResDesc {
  field: string;
  path: string;
  singleKey?: string;
  listKey?: string;
  create: CreateKind | null;
  get?: boolean;
  update?: boolean;
}

const DESCRIPTORS: ResDesc[] = [
  { field: 'articles',    path: 'articles',         singleKey: 'article',       listKey: 'articles',         create: 'raw' },
  { field: 'assetLayouts', path: 'asset_layouts',    singleKey: 'asset_layout',  listKey: 'asset_layouts',    create: 'wrapped' },
  { field: 'assetPasswords', path: 'asset_passwords', singleKey: 'asset_password', listKey: 'asset_passwords', create: 'wrapped' },
  { field: 'flagTypes',   path: 'flag_types',       singleKey: 'flag_type',     listKey: 'flag_types',       create: 'wrapped' },
  { field: 'flags',       path: 'flags',            singleKey: 'flag',          listKey: 'flags',            create: 'wrapped' },
  { field: 'folders',     path: 'folders',          singleKey: 'folder',        listKey: 'folders',          create: 'wrapped' },
  { field: 'groups',      path: 'groups',           singleKey: undefined,       listKey: undefined,          create: null },
  { field: 'ipAddresses', path: 'ip_addresses',     singleKey: undefined,       listKey: undefined,          create: 'raw' },
  { field: 'labelTypes',  path: 'label_types',      singleKey: 'label_type',    listKey: 'label_types',      create: 'wrapped' },
  { field: 'labels',      path: 'labels',           singleKey: 'label',         listKey: 'labels',           create: 'wrapped' },
  { field: 'lists',       path: 'lists',            singleKey: undefined,       listKey: undefined,          create: 'raw' },
  { field: 'networks',    path: 'networks',         singleKey: undefined,       listKey: undefined,          create: 'raw' },
  { field: 'passwordFolders', path: 'password_folders', singleKey: 'password_folder', listKey: 'password_folders', create: 'wrapped' },
  { field: 'procedureTasks', path: 'procedure_tasks',  singleKey: 'procedure_task',  listKey: 'procedure_tasks',  create: 'wrapped' },
  { field: 'rackStorageItems', path: 'rack_storage_items', singleKey: undefined, listKey: undefined, create: 'wrapped' },
  { field: 'rackStorages', path: 'rack_storages',   singleKey: undefined,       listKey: undefined,          create: 'raw' },
  { field: 'users',       path: 'users',            singleKey: undefined,       listKey: undefined,          create: null },
  { field: 'vlanZones',   path: 'vlan_zones',       singleKey: undefined,       listKey: undefined,          create: 'raw' },
  { field: 'vlans',       path: 'vlans',            singleKey: undefined,       listKey: undefined,          create: 'raw' },
  { field: 'websites',    path: 'websites',         singleKey: undefined,       listKey: undefined,          create: 'raw' },
  { field: 'matchers',    path: 'matchers',         singleKey: undefined,       listKey: 'matchers',         create: null, get: false },
  { field: 'relations',   path: 'relations',        singleKey: undefined,       listKey: 'relations',        create: 'wrapped', get: false, update: false },
];

function makeClient() { return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }); }

describe('standard CRUD resources', () => {
  afterEach(() => clearFetch());

  describe.each(DESCRIPTORS)('$field', (desc) => {
    const base = `https://hudu.example.com/api/v1/${desc.path}`;
    const obj = { id: 1, name: 'thing', slug: 'thing-1' };
    const listResp = desc.listKey
      ? { [desc.listKey]: [obj] }
      : [obj];

    if (desc.get !== false) {
      it('get returns the (unwrapped) record', async () => {
        const spy = stubFetch(() => json(desc.singleKey ? { [desc.singleKey]: obj } : obj));
        const res = await (makeClient() as any)[desc.field].get(1);
        expect(res).toEqual(obj);
        expect(spy.calls[0].url).toBe(`${base}/1`);
      });
    }

    it('listAll collects the list', async () => {
      const spy = stubFetch(() => json(listResp));
      const res = await (makeClient() as any)[desc.field].listAll({});
      expect(res).toEqual([obj]);
      expect(spy.calls[0].url).toContain(base);
    });

    it('list streams items', async () => {
      stubFetch(() => json(listResp));
      const out: unknown[] = [];
      for await (const item of (makeClient() as any)[desc.field].list({})) out.push(item);
      expect(out).toEqual([obj]);
    });

    it('listPages yields page objects', async () => {
      stubFetch(() => json(listResp));
      const pages: unknown[] = [];
      for await (const pageObj of (makeClient() as any)[desc.field].listPages({})) pages.push(pageObj);
      expect(pages).toHaveLength(1);
      expect((pages[0] as { items: unknown[] }).items).toEqual([obj]);
    });

    if (desc.create) {
      it('create posts and normalises the response', async () => {
        const spy = stubFetch(() => json(desc.create === 'wrapped' && desc.singleKey ? { [desc.singleKey]: obj } : obj, 201));
        const res = await (makeClient() as any)[desc.field].create({ name: 'thing' });
        expect(res).toEqual(obj);
        expect(spy.calls[0].init.method).toBe('POST');
      });

      if (desc.update !== false) {
        it('update puts and normalises the response', async () => {
          const spy = stubFetch(() => json(desc.create === 'wrapped' && desc.singleKey ? { [desc.singleKey]: obj } : obj));
          const res = await (makeClient() as any)[desc.field].update(1, { name: 'x' });
          expect(res).toEqual(obj);
          expect(spy.calls[0].init.method).toBe('PUT');
          expect(spy.calls[0].url).toBe(`${base}/1`);
        });
      }
    }

  });

  // delete coverage (skip resources without DELETE)
  it.each([
    ['articles', 'articles/1'],
    ['assetPasswords', 'asset_passwords/1'],
    ['flagTypes', 'flag_types/1'],
    ['flags', 'flags/1'],
    ['folders', 'folders/1'],
    ['ipAddresses', 'ip_addresses/1'],
    ['labelTypes', 'label_types/1'],
    ['labels', 'labels/1'],
    ['lists', 'lists/1'],
    ['networks', 'networks/1'],
    ['passwordFolders', 'password_folders/1'],
    ['procedureTasks', 'procedure_tasks/1'],
    ['rackStorageItems', 'rack_storage_items/1'],
    ['rackStorages', 'rack_storages/1'],
    ['relations', 'relations/1'],
    ['vlanZones', 'vlan_zones/1'],
    ['vlans', 'vlans/1'],
    ['websites', 'websites/1'],
    ['matchers', 'matchers/1'],
  ])('delete on %s returns void', async (field, path) => {
    const spy = stubFetch(() => empty(204));
    const r = (makeClient() as any)[field];
    await expect(r.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe(`https://hudu.example.com/api/v1/${path}`);
    expect(spy.calls[0].init.method).toBe('DELETE');
  });

  // archive/unarchive coverage
  it.each([
    ['articles', 'articles'],
    ['assetPasswords', 'asset_passwords'],
  ])('archive/unarchive on %s', async (field, path) => {
    const spy = stubFetch(() => empty(204));
    const r = (makeClient() as any)[field];
    await r.archive(1);
    await r.unarchive(1);
    expect(spy.calls[0].url).toBe(`https://hudu.example.com/api/v1/${path}/1/archive`);
    expect(spy.calls[1].url).toBe(`https://hudu.example.com/api/v1/${path}/1/unarchive`);
  });

  // articles archive/unarchive covered above; also plain update via raw
});
