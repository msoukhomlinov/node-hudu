/**
 * Knowledge search engine tests: matching, scoring, tiers, honesty, snippets and bounds.
 *
 * The engine is driven directly (fake deps) so an index shape, a bound or a vendor failure can be
 * staged exactly; the HTTP path is covered separately at the bottom through the real client and the
 * shared fetch stub. Everything is local: no test here touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  KnowledgeSearchEngine,
  type EngineDeps,
  type VendorRow,
} from '../../src/search/engine.js';
import { htmlToText } from '../../src/search/html.js';
import type { Page } from '../../src/pagination.js';
import type { KnowledgeResource } from '../../src/types/search_knowledge.js';
import { HuduConfigError } from '../../src/errors.js';
import { HuduClient } from '../../src/client.js';
import { Operations } from '../../src/operations/index.js';
import { stubFetch, json, clearFetch, type FetchHandler } from '../helpers.js';

type Row = Record<string, unknown>;

/** Chunk rows into pages, honouring the requested page size. */
function paged(rows: Row[], pageSize: number): Page<Row>[] {
  const pages: Page<Row>[] = [];
  for (let i = 0; i < rows.length; i += pageSize) {
    pages.push({ items: rows.slice(i, i + pageSize), page: pages.length + 1, page_size: pageSize, hasMore: i + pageSize < rows.length });
  }
  if (pages.length === 0) pages.push({ items: [], page: 1, page_size: pageSize, hasMore: false });
  return pages;
}

async function* iterate(pages: Page<Row>[]): AsyncIterable<Page<Row>> {
  for (const page of pages) yield page;
}

const A1 = {
  id: 16,
  name: 'FortiGate VPN site-to-site troubleshooting',
  slug: 'fortigate-vpn',
  url: 'https://hudu.example.com/articles/16',
  company_id: 7,
  updated_at: '2026-01-01T00:00:00.000Z',
  content: '<p>Check the tunnel, then review the related threat technique kerberoasting.</p>',
};

const A2 = {
  id: 27,
  name: 'Onboarding checklist',
  slug: 'onboarding-checklist',
  url: 'https://hudu.example.com/articles/27',
  company_id: 7,
  updated_at: '2026-02-01T00:00:00.000Z',
  content: '<p>Assign the E5 licence and run the printer toner check.</p>',
};

const ASSET = {
  id: 332,
  name: 'AUPOST-WS001',
  slug: 'aupost-ws001',
  url: 'https://hudu.example.com/assets/332',
  company_id: 20,
  company_name: 'Australia Post',
  primary_serial: 'SN-4471',
  primary_model: 'OptiPlex 7090',
  primary_manufacturer: 'Dell',
  updated_at: '2026-03-01T00:00:00.000Z',
  fields: [
    { label: 'Service tag', value: '7GH2K83' },
    { label: 'RAM', value: '16GB' },
  ],
};

/** Fake deps: article/asset pages plus a per-resource vendor search that never throws by default. */
function deps(
  options: {
    articles?: Row[];
    assets?: Row[];
    vendor?: Partial<Record<KnowledgeResource, Row[] | Error>>;
    pageSize?: number;
  } = {},
): EngineDeps {
  const articles = options.articles ?? [A1, A2];
  const assets = options.assets ?? [ASSET];
  const pageSize = options.pageSize ?? 2;
  return {
    listArticlePages: (params) => iterate(paged(articles, params.page_size ?? pageSize)),
    listAssetPages: (params) => iterate(paged(assets, params.page_size ?? pageSize)),
    vendorSearch: async (resource, query): Promise<VendorRow[]> => {
      const staged = options.vendor?.[resource];
      if (staged instanceof Error) throw staged;
      const rows = staged ?? (resource === 'articles' ? articles : resource === 'assets' ? assets : []);
      const needle = query.toLowerCase();
      return rows
        .filter((row) => String(row.name).toLowerCase().includes(needle))
        .map((row) => ({ id: Number(row.id), label: String(row.name), item: row }));
    },
  };
}

function engine(options: Parameters<typeof deps>[0] = {}, config = {}) {
  return new KnowledgeSearchEngine(deps(options), config);
}

describe('knowledge search engine', () => {
  it('returns ranked hits with a verbatim snippet and a fetch call', async () => {
    const search = engine();
    const result = await search.search('kerberoasting', { tier: 'index' });
    expect(result.hits.length).toBe(1);
    const hit = result.hits[0];
    expect(hit.resource).toBe('articles');
    expect(hit.id).toBe(16);
    expect(hit.title).toBe('FortiGate VPN site-to-site troubleshooting');
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.relevance).toBe(1);
    expect(hit.scoreScope).toBe('cross-resource');
    expect(hit.match.fields).toEqual(['body']);
    expect(hit.match.terms).toEqual(['kerberoasting']);
    expect(hit.match.coverage).toBe(1);
    expect(hit.match.fuzzy).toBe(false);
    expect(hit.snippet?.available).toBe(true);
    expect(hit.snippet?.text.toLowerCase()).toContain('kerberoasting');
    expect(hit.snippet?.source).toBe('article.content');
    expect(hit.fetch).toEqual({ operation: 'articles.get', args: { id: 16 } });
    expect(hit.company).toEqual({ id: 7 });
    expect(result.meta.query).toBe('kerberoasting');
    expect(result.meta.returned).toBe(1);
    expect(result.meta.limit).toBe(8);
    expect(result.meta.complete).toBe(true);
    expect(result.meta.reasons).toEqual([]);
    expect(result.meta.degraded).toBeNull();
    expect(result.meta.index.state).toBe('warm');
    expect(result.meta.index.docs.articles?.indexed).toBe(2);
    expect(result.meta.bytes).toBeGreaterThan(0);
    expect(result.meta.indexAge).toBeGreaterThanOrEqual(0);
  });

  it('finds a term that exists only in an article body (the vendor cannot)', async () => {
    const cold = engine();
    const vendorOnly = await cold.search('kerberoasting', { tier: 'vendor' });
    expect(vendorOnly.hits).toEqual([]);
    expect(vendorOnly.meta.degraded).toEqual({
      reason: 'body-not-indexed',
      advice: expect.stringContaining('body'),
    });
    expect(vendorOnly.meta.complete).toBe(false);
    expect(vendorOnly.meta.scoreScope).toBe('per-resource');
    expect(vendorOnly.meta.index.state).toBe('cold');
    expect(vendorOnly.meta.indexAge).toBeNull();

    const warm = engine();
    const bodyHit = await warm.search('kerberoasting', { tier: 'index' });
    expect(bodyHit.hits.map((hit) => hit.id)).toEqual([16]);
    expect(bodyHit.meta.scoreScope).toBe('cross-resource');
  });

  it('tolerates a typo in a title word and in a digit-bearing identifier', async () => {
    const search = engine();
    await search.warm();
    const title = await search.search('Onboardng checklist', { tier: 'index' });
    expect(title.hits[0]?.id).toBe(27);
    expect(title.hits[0]?.match.fuzzy).toBe(true);
    expect(title.hits[0]?.match.fields).toContain('title');

    const serial = await search.search('7gh2k84', { tier: 'index' });
    expect(serial.hits[0]?.resource).toBe('assets');
    expect(serial.hits[0]?.id).toBe(332);
    expect(serial.hits[0]?.fetch).toEqual({ operation: 'assets.get', args: { companyId: 20, id: 332 } });
    expect(serial.hits[0]?.match.fields).toEqual(['custom_field']);
  });

  it('answers from the vendor tier when the index is cold and from the index tier when it is warm', async () => {
    const search = engine();
    expect(search.status().state).toBe('cold');
    const cold = await search.search('onboarding', { tier: 'vendor' });
    expect(cold.meta.index.state).toBe('cold');
    expect(cold.meta.scoreScope).toBe('per-resource');
    expect(cold.meta.degraded?.reason).toBe('vendor-only');
    expect(cold.hits[0]?.id).toBe(27);
    expect(cold.hits[0]?.snippet?.available).toBe(false);
    expect(cold.meta.timings.requests).toBeGreaterThan(0);

    await search.warm();
    expect(search.status().state).toBe('warm');
    expect(search.status().staleness).toBe('fresh');
    const warm = await search.search('onboarding', { tier: 'index' });
    expect(warm.meta.index.state).toBe('warm');
    expect(warm.meta.scoreScope).toBe('cross-resource');
    expect(warm.meta.degraded).toBeNull();
    expect(warm.meta.index.docs.articles?.bodiesIndexed).toBe(2);

    // `refresh: true` re-walks every source (the only way a DELETED document disappears).
    const refreshed = await search.search('onboarding', { refresh: true });
    expect(refreshed.meta.index.state).toBe('warm');
    expect(refreshed.hits[0]?.id).toBe(27);
  });

  it('names every bound that bit and reports body-not-indexed for an empty body-blind search', async () => {
    const capped = engine({}, { maxDocsScored: 1 });
    await capped.warm();
    const candidateCap = await capped.search('check', { tier: 'index' });
    expect(candidateCap.meta.reasons).toContain('candidate-cap');
    expect(candidateCap.meta.truncation?.reason).toBe('candidate-cap');
    expect(candidateCap.meta.complete).toBe(false);

    const partial = engine({}, { maxIndexPages: 1, pageSize: 1 });
    await partial.warm();
    const status = partial.status();
    expect(status.state).toBe('partial');
    expect(status.docs.articles?.totalKnown).toBeNull();
    const partialResult = await partial.search('kerberoasting', { tier: 'index' });
    expect(partialResult.meta.reasons).toContain('index-partial');
    expect(partialResult.meta.index.state).toBe('partial');

    const tiny = engine({}, { bounds: { maxDocBytes: 40, maxIndexTextBytes: 1024 * 1024, maxDocs: 20_000 } });
    await tiny.warm();
    const truncated = await tiny.search('kerberoasting', { tier: 'index' });
    expect(tiny.status().docs.articles?.bodiesTruncated).toBeGreaterThan(0);
    expect(truncated.meta.reasons).toContain('body-truncated');

    const narrow = engine({}, { maxResponseBytes: 120 });
    await narrow.warm();
    const limited = await narrow.search('check', { limit: 25, tier: 'index' });
    expect(limited.meta.reasons).toContain('result-limit');
    expect(limited.meta.truncation?.reason).toBe('result-limit');
    expect(limited.hits.length).toBeLessThan(25);
  });

  it('degrades a failing resource to meta.errors instead of losing the call', async () => {
    const search = engine({ vendor: { assets: new HuduConfigError('assets search is down', { code: 'NETWORK_ERROR' } as never) } });
    await search.warm();
    const result = await search.search('onboarding', { tier: 'index' });
    expect(result.meta.errors.length).toBe(1);
    expect(result.meta.errors[0]?.resource).toBe('assets');
    expect(result.meta.errors[0]?.message).toContain('assets search is down');
    expect(result.meta.failed).toEqual(result.meta.errors);
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('refuses a limit above the maximum of 25 instead of clamping it', async () => {
    const search = engine();
    await expect(search.search('a', { limit: 26 })).rejects.toThrow(HuduConfigError);
    await expect(search.search('a', { limit: 0 })).rejects.toThrow(/positive integer/);
    await expect(search.search('a', { scope: ['activity_logs'] as never })).rejects.toThrow(/not a searchable resource/);
    await expect(search.search('a', { scope: [] })).rejects.toThrow(/non-empty array/);
    await expect(search.search('   ')).rejects.toThrow(/non-empty query/);
    const overVendor = engine({}, { maxVendorRequests: 1 });
    const result = await overVendor.search('onboarding', { tier: 'vendor', scope: ['articles', 'assets'] });
    expect(result.meta.errors.map((entry) => entry.resource)).toEqual(['assets']);
  });

  it('snippet text is exactly the extracted slice its offsets name', async () => {
    const search = engine();
    await search.warm();
    const result = await search.search('kerberoasting', { tier: 'index' });
    const snippet = result.hits[0]?.snippet;
    expect(snippet).toBeDefined();
    const extracted = htmlToText(String(A1.content), { maxDocBytes: 256 * 1024 });
    expect(snippet?.text).toBe(extracted.slice(snippet.textStart, snippet.textEnd));
    const span = snippet?.spans[0];
    expect(span).toBeDefined();
    expect(snippet?.text.slice(span?.[0] as number, span?.[1] as number).toLowerCase()).toBe('kerberoasting');
  });

  it('caps the index by documents, text bytes and response size and says which bound bit', async () => {
    const many: Row[] = Array.from({ length: 6 }, (_, i) => ({
      id: 100 + i,
      name: `Runbook ${i}`,
      slug: `runbook-${i}`,
      updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      content: `<p>runbook body ${i}</p>`,
    }));
    const capped = engine({ articles: many }, { bounds: { maxDocBytes: 256 * 1024, maxIndexTextBytes: 1024 * 1024, maxDocs: 2 } });
    await capped.warm();
    // maxDocs is a GLOBAL cap: the two freshest documents win, and the 2026-03-01 asset beats
    // five of the six articles.
    expect(capped.status().docs.articles?.indexed).toBe(1);
    expect(capped.status().docs.assets?.indexed).toBe(1);

    const evicting = engine({ articles: many }, { bounds: { maxDocBytes: 256 * 1024, maxIndexTextBytes: 1, maxDocs: 20_000 } });
    await evicting.warm();
    const evicted = await evicting.search('runbook', { tier: 'index' });
    expect(evicted.hits.length).toBeGreaterThan(0);
    expect(evicted.hits.some((hit) => hit.snippet?.reason === 'evicted')).toBe(true);
  });
});


describe('operations.searchKnowledge (through the real client)', () => {
  afterEach(() => clearEmpty());

  /** The vendor is body-blind: `search=` on articles returns nothing for a body-only term. */
  const handler: FetchHandler = (url) => {
    if (url.includes('/articles') && url.includes('search=')) return json({ articles: [] });
    if (url.includes('/articles')) return json({ articles: [A1, A2] });
    if (url.includes('/assets') && url.includes('search=')) return json({ assets: [] });
    if (url.includes('/assets')) return json({ assets: [ASSET] });
    return json({ error: 'unexpected request: ' + url }, 500);
  };

  /** `clearFetch` is the stub's own teardown; wrapped so the describe block reads as one line. */
  function clearEmpty(): void {
    clearFetch();
  }

  it('indexes article bodies from the LIST payload and needs no per-record GET', async () => {
    const spy = stubFetch(handler, { baseUrl: 'https://hudu.example.com' });
    const ops = new Operations(new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' }));

    // Cold client: answered from the vendor, and it SAYS bodies were not searched.
    const cold = await ops.searchKnowledge('kerberoasting');
    expect(cold.hits).toEqual([]);
    expect(cold.meta.degraded?.reason).toBe('body-not-indexed');

    // Forced index tier: the body index is built from the list pages themselves.
    const warm = await ops.searchKnowledge('kerberoasting', { tier: 'index' });
    expect(warm.hits[0]?.id).toBe(16);
    expect(warm.meta.scoreScope).toBe('cross-resource');
    expect(warm.meta.timings.requests).toBeGreaterThan(0);
    const perRecord = spy.calls.filter((call) => /\/articles\/\d+|\/assets\/\d+/.test(call.url));
    expect(perRecord).toEqual([]);
  });
});
