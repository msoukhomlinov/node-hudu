/**
 * Pagination helper tests.
 */
import { describe, it, expect } from 'vitest';
import { paginate, paginateItems, collectAll, toArray, type Page } from '../src/pagination.js';
import { HttpClient } from '../src/http.js';
import { resolveConfig } from '../src/config.js';
import { IpAddressesResource } from '../src/resources/ip_addresses.js';
import { stubFetch, json, clearFetch } from './helpers.js';

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
});
