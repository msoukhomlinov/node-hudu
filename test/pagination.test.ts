/**
 * Pagination helper tests.
 */
import { describe, it, expect } from 'vitest';
import { paginate, paginateItems, collectAll, toArray, type Page } from '../src/pagination.js';
import { HttpClient } from '../src/http.js';
import { resolveConfig } from '../src/config.js';
import { IpAddressesResource } from '../src/resources/ip_addresses.js';
import { CompaniesResource } from '../src/resources/companies.js';
import { ListsResource } from '../src/resources/lists.js';
import { NetworksResource } from '../src/resources/networks.js';
import { ProcedureTasksResource } from '../src/resources/procedure_tasks.js';
import { RackStorageItemsResource } from '../src/resources/rack_storage_items.js';
import { RackStoragesResource } from '../src/resources/rack_storages.js';
import { VlanZonesResource } from '../src/resources/vlan_zones.js';
import { VlansResource } from '../src/resources/vlans.js';
import { HuduConfigError } from '../src/errors.js';
import { stubFetch, json, empty, clearFetch } from './helpers.js';

function page(items: number[], pageNo: number, pageSize: number, hasMore: boolean): Page<number> {
  return { items, page: pageNo, page_size: pageSize, hasMore };
}

describe('paginate', () => {
  it('walks pages until a short page', async () => {
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (pageNo: number): Promise<Page<number>> => {
      if (pageNo === 1) return page(full, 1, 25, true);
      return page([26, 27], 2, 25, false); // short -> stop
    });
    const out: number[][] = [];
    for await (const p of paginate(fetcher)) out.push(p.items);
    expect(out).toEqual([full, [26, 27]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops when hasMore is false even on a full page', async () => {
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (pageNo: number): Promise<Page<number>> => {
      if (pageNo === 1) return page(full, 1, 25, true);
      return page(Array.from({ length: 25 }, (_, i) => i + 26), 2, 25, false);
    });
    const pages: Page<number>[] = [];
    for await (const p of paginate(fetcher)) pages.push(p);
    expect(pages).toHaveLength(2);
    expect(pages[1].hasMore).toBe(false);
  });
});

describe('paginateItems', () => {
  it('yields items across pages', async () => {
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (pageNo: number): Promise<Page<number>> => {
      if (pageNo === 1) return page(full, 1, 25, true);
      return page([26], 2, 25, false);
    });
    const items: number[] = [];
    for await (const it of paginateItems(fetcher)) items.push(it);
    expect(items).toEqual([...full, 26]);
  });
});

describe('collectAll', () => {
  it('collects all pages into a flat array', async () => {
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (pageNo: number): Promise<Page<number>> => {
      if (pageNo === 1) return page(full, 1, 25, true);
      return page([26, 27, 28], 2, 25, false);
    });
    await expect(collectAll(fetcher)).resolves.toEqual([...full, 26, 27, 28]);
  });
});

describe('toArray', () => {
  it('materialises an async iterator', async () => {
    async function* gen() { yield 1; yield 2; yield 3; }
    await expect(toArray(gen())).resolves.toEqual([1, 2, 3]);
  });
});

describe('non-paginated single call', () => {
  it('ip_addresses.listAll issues a single GET and unwraps the sole list', async () => {
    const spy = stubFetch(() => json([{ id: 1, address: '10.0.0.1' }]));
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));
    const res = new IpAddressesResource(http);
    const all = await res.listAll({});
    expect(all).toEqual([{ id: 1, address: '10.0.0.1' }]);
    // single call, no pagination params appended
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/ip_addresses');
    clearFetch();
  });

  it('strips caller-supplied page/page_size from a non-paginated endpoint (A11)', async () => {
    // Spec: GET /lists accepts only `name`/`query` — never page/page_size.
    const spy = stubFetch(() => json([{ id: 1, name: 'edge' }]));
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));
    const res = new ListsResource(http);
    // page/page_size are typed on ListParams, so this compiles even though the
    // endpoint ignores them; the library must strip them from the query string.
    const all = await res.listAll({ page_size: 100, page: 3, name: 'edge' });
    expect(all).toEqual([{ id: 1, name: 'edge' }]);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/lists?name=edge');
    clearFetch();
  });
});


describe('non-paginated resources never forward page/page_size (B20 regression guard)', () => {
  const cases: Array<{ name: string; ctor: new (h: HttpClient) => { listAll(p: unknown): Promise<unknown[]> } }> = [
    { name: 'lists', ctor: ListsResource },
    { name: 'ip_addresses', ctor: IpAddressesResource },
    { name: 'networks', ctor: NetworksResource },
    { name: 'rack_storages', ctor: RackStoragesResource },
    { name: 'rack_storage_items', ctor: RackStorageItemsResource },
    { name: 'vlans', ctor: VlansResource },
    { name: 'vlan_zones', ctor: VlanZonesResource },
    { name: 'procedure_tasks', ctor: ProcedureTasksResource },
  ];
  for (const { name, ctor } of cases) {
    it(`${name}.listAll strips page/page_size even when the caller supplies them (A11/B20)`, async () => {
      const spy = stubFetch(() => json([{ id: 1 }]));
      const http = new HttpClient(resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));
      const r = new ctor(http);
      await r.listAll({ page: 7, page_size: 100 });
      expect(spy.calls).toHaveLength(1);
      // URL must contain neither `page` nor `page_size`, exactly matching base'!/!path.
      expect(spy.calls[0].url).toBe(`https://hudu.example.com/api/v1/${name}`);
      expect(spy.calls[0].url).not.toContain('page');
      clearFetch();
    });
  }
});

describe('no-progress guard — opt-in via guardNoProgress (B5/F4)', () => {
  it('throws when a server ignores `page` and keeps returning the same full page (B5)', async () => {
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (): Promise<Page<number>> => page(full, 1, 25, true));
    const iter = paginate(fetcher, { guardNoProgress: true });
    // First page is normally yielded; the repeat is recognised as no progress.
    const first = await iter.next();
    expect(first.value).toEqual(page(full, 1, 25, true));
    await expect(iter.next()).rejects.toBeInstanceOf(HuduConfigError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('allows pages whose CONTENT advances to keep iterating (no-progress regression)', async () => {
    // Distinct item ids per page number — a healthy, genuinely-advancing page.
    // The no-progress guard must NOT misfire on real progress.
    const fetcher = vi.fn(async (pageNo: number): Promise<Page<number>> => {
      const items = Array.from({ length: 25 }, (_, i) => (pageNo - 1) * 25 + i + 1);
      return page(items, pageNo, 25, true);
    });
    const out: Page<number>[] = [];
    // Cap how far we walk so the test terminates even if the guard misfired.
    for await (const p of paginate(fetcher, { page: 1, page_size: 25, guardNoProgress: true })) {
      out.push(p);
      if (p.page >= 3) break;
    }
    expect(out.map((p) => p.page)).toEqual([1, 2, 3]);
    // All three pages must have distinct first-item ids (content advanced).
    expect(new Set(out.map((p) => p.items[0])).size).toBe(3);
  });

  it('does NOT enforce the no-progress check by default (F4)', async () => {
    // A constant-page fetcher without guardNoProgress is a valid external
    // contract; the check must not run.
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (): Promise<Page<number>> => page(full, 1, 25, true));
    const iter = paginate(fetcher);
    const first = await iter.next();
    expect(first.value).toEqual(page(full, 1, 25, true));
    const second = await iter.next();
    expect(second.value).toEqual(page(full, 1, 25, true));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('throws the no-progress error only when guardNoProgress is set (F4)', async () => {
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (): Promise<Page<number>> => page(full, 1, 25, true));
    const iter = paginate(fetcher, { guardNoProgress: true });
    await iter.next();
    await expect(iter.next()).rejects.toBeInstanceOf(HuduConfigError);
  });

  it('yields a repeated SHORT/final page normally even with guardNoProgress (codex [4])', async () => {
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (pageNo: number): Promise<Page<number>> => {
      if (pageNo === 1) return page(full, 1, 25, true);
      // Final page: same reported page number, but short + hasMore false.
      return page([26, 27], 1, 25, false);
    });
    const out: number[][] = [];
    for await (const p of paginate(fetcher, { guardNoProgress: true })) out.push(p.items);
    expect(out).toEqual([full, [26, 27]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('yields a terminal hasMore:false full page normally even with guardNoProgress (codex [4])', async () => {
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (pageNo: number): Promise<Page<number>> => {
      if (pageNo === 1) return page(full, 1, 25, true);
      // Full-length page but hasMore:false — terminal, must be yielded.
      return page(Array.from({ length: 25 }, (_, i) => i + 26), 1, 25, false);
    });
    const pages: Page<number>[] = [];
    for await (const p of paginate(fetcher, { guardNoProgress: true })) pages.push(p);
    expect(pages).toHaveLength(2);
    expect(pages[1].hasMore).toBe(false);
  });

  it('yields an immediately-terminal first page even with guardNoProgress (codex [4])', async () => {
    const fetcher = vi.fn(async (): Promise<Page<number>> => page([1, 2], 1, 25, false));
    const out: number[][] = [];
    for await (const p of paginate(fetcher, { guardNoProgress: true })) out.push(p.items);
    expect(out).toEqual([[1, 2]]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws for repeated full hasMore:true pages by CONTENT signature (codex [6])', async () => {
    // Server ignores `page`: identical content every time, even as the
    // requested page number advances. Content-based detection must throw.
    const full = Array.from({ length: 25 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (pageNo: number): Promise<Page<number>> => page(full, pageNo, 25, true));
    const iter = paginate(fetcher, { guardNoProgress: true });
    const first = await iter.next();
    expect(first.value.items).toEqual(full);
    await expect(iter.next()).rejects.toBeInstanceOf(HuduConfigError);
  });

  it('allows a REPEATED page number when content advances (codex [6] regression)', async () => {
    // One pathological shape: the server keeps reporting page 1, but the items
    // genuinely advance. Content differs each time, so no no-progress throw.
    let n = 0;
    const fetcher = vi.fn(async (): Promise<Page<number>> => {
      n += 1;
      return page(Array.from({ length: 25 }, (_, i) => (n - 1) * 25 + i + 1), 1, 25, true);
    });
    const out: Page<number>[] = [];
    for await (const p of paginate(fetcher, { guardNoProgress: true })) {
      out.push(p);
      if (out.length >= 3) break;
    }
    expect(out.map((p) => p.items[0])).toEqual([1, 26, 51]);
  });
});

describe('non-paginated response shape (C12)', () => {
  it('non-paginated empty result reports page_size 0, not a fabricated 1 (C12)', async () => {
    const spy = stubFetch(() => json([]));
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));
    const lists = new ListsResource(http);
    const pages: Array<{ page: number; page_size: number; items: unknown[] }> = [];
    for await (const p of lists.listPages({})) pages.push({ page: p.page, page_size: p.page_size, items: p.items });
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(1);
    expect(pages[0].page_size).toBe(0);
    expect(pages[0].items).toEqual([]);
    clearFetch();
  });
});

describe('pagination input validation', () => {
  it('rejects page_size 0 / negative / NaN on a list call (infinite-loop guard, A12)', async () => {
    const spy = stubFetch(() => json([]));
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));
    const res = new IpAddressesResource(http);
    await expect(res.listAll({ page_size: 0 })).rejects.toBeInstanceOf(HuduConfigError);
    await expect(res.listAll({ page_size: -1 })).rejects.toBeInstanceOf(HuduConfigError);
    await expect(res.listAll({ page_size: 1.5 })).rejects.toBeInstanceOf(HuduConfigError);
    // page_size:1 remains valid
    await expect(res.listAll({ page_size: 1, page: 1 })).resolves.toEqual([]);
    clearFetch();
  });

  it('rejects page_size 0 passed directly to paginate (A12)', async () => {
    const fetcher = async (pageNo: number): Promise<Page<number>> => page([], pageNo, 0, false);
    await expect(paginate(fetcher, { page_size: 0 }).next()).rejects.toBeInstanceOf(HuduConfigError);
  });

  it('rejects non-integer and non-positive page (F8)', async () => {
    const spy = stubFetch(() => json([]));
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));
    const res = new IpAddressesResource(http);
    await expect(res.listAll({ page: 1.5 })).rejects.toBeInstanceOf(HuduConfigError);
    await expect(res.listAll({ page: -3 })).rejects.toBeInstanceOf(HuduConfigError);
    await expect(res.listAll({ page: 0 })).rejects.toBeInstanceOf(HuduConfigError);
    // page:1 remains valid
    await expect(res.listAll({ page: 1 })).resolves.toEqual([]);
    clearFetch();
  });

  it('rejects an invalid page passed directly to paginate (F8)', async () => {
    const fetcher = async (pageNo: number): Promise<Page<number>> => page([], pageNo, 25, false);
    await expect(paginate(fetcher, { page: 1.5 }).next()).rejects.toBeInstanceOf(HuduConfigError);
    await expect(paginate(fetcher, { page: -3 }).next()).rejects.toBeInstanceOf(HuduConfigError);
    await expect(paginate(fetcher, { page: 0 }).next()).rejects.toBeInstanceOf(HuduConfigError);
  });
});

describe('empty-list body handling (F3)', () => {
  it('a 200 empty body yields [] from listPages/listAll, not an ENVELOPE_ERROR', async () => {
    stubFetch(() => empty(200));
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));
    const res = new CompaniesResource(http);
    await expect(res.listAll({})).resolves.toEqual([]);
    const pages: Array<{ items: unknown[] }> = [];
    for await (const p of res.listPages({})) pages.push(p);
    // a single page with empty items — NOT an ENVELOPE_ERROR / endless loop
    expect(pages).toHaveLength(1);
    expect(pages[0].items).toEqual([]);
    clearFetch();
  });

  it('a {listKey:null} body yields [] from listPages/listAll', async () => {
    stubFetch(() => json({ companies: null }));
    const http = new HttpClient(resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));
    const res = new CompaniesResource(http);
    await expect(res.listAll({})).resolves.toEqual([]);
    const pages: Array<{ items: unknown[] }> = [];
    for await (const p of res.listPages({})) pages.push(p);
    expect(pages).toHaveLength(1);
    expect(pages[0].items).toEqual([]);
    clearFetch();
  });
});
