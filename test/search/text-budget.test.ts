/**
 * Text-budget eviction order (`maxIndexTextBytes`) — issue #46.
 *
 * The defect these tests pin: with the default budget, an asset-heavy tenant had EVERY article body
 * evicted while asset field text was retained, so `tier: 'index'` answered body-blind. Eviction was
 * plain least-recently-read over every evictable document, and during a build the LRU clock is empty,
 * so insertion order - which is walk order, articles first and then assets - decided the victims.
 *
 * The rule now: a document is a victim only while its own resource holds MORE than its limit, where
 * the limit is its share of the budget plus whatever the other declared long-text source leaves
 * unused (the invariant is stated in `src/search/index-store.ts`, beside the eviction loop). A corpus
 * that fits inside its share is therefore not evicted to pay for the other resource's overflow.
 *
 * The engine is driven directly with fake deps (the shape of `engine.test.ts`): no network, and the
 * corpus shape and the bounds are staged exactly. Corpora are deliberately small - victim selection
 * is a full scan per eviction (a pre-existing O(n*v)), so a large probe belongs in `.run/`, not here.
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSearchEngine, type EngineDeps } from '../../src/search/engine.js';
import type { Page } from '../../src/pagination.js';

type Row = Record<string, unknown>;

/** ~880 bytes of ASCII body text per article row, and ~890 bytes of `cfield` text per asset row. */
const BIG = 'needlebody '.repeat(80);

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

const article = (id: number, day: number, content: string): Row => ({
  id,
  name: `Runbook ${id}`,
  slug: `runbook-${id}`,
  url: `https://hudu.example.com/articles/${id}`,
  company_id: 1,
  updated_at: `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  content: `<p>${content}</p>`,
});

const asset = (id: number, value: string): Row => ({
  id,
  name: `ASSET-${id}`,
  slug: `asset-${id}`,
  url: `https://hudu.example.com/assets/${id}`,
  company_id: 1,
  company_name: 'Australia Post',
  updated_at: '2026-02-01T00:00:00.000Z',
  fields: [{ label: 'Notes', value }],
});

const articles = (count: number): Row[] =>
  Array.from({ length: count }, (_v, i) => article(i + 1, i + 1, `${BIG} article ${i + 1}`));

const assets = (count: number): Row[] =>
  Array.from({ length: count }, (_v, i) => asset(1000 + i, `${BIG} assetfield ${i}`));

/**
 * Fake deps over LIVE arrays (a row replaced in place is seen by the next walk) and a vendor search
 * that returns nothing, so every hit in these tests comes from the index.
 *
 * The article walk honours the `updated_at` watermark the way the vendor does for `/articles`
 * (inclusive, trailing comma stripped): that is what makes the incremental-build case a real
 * incremental walk rather than a second full one.
 */
function deps(options: { articles?: Row[]; assets?: Row[]; pageSize?: number } = {}): EngineDeps {
  const articleRows = options.articles ?? [];
  const assetRows = options.assets ?? [];
  const pageSize = options.pageSize ?? 100;
  return {
    listArticlePages: (params) => {
      const watermark = typeof params.updated_at === 'string' ? params.updated_at.replace(/,$/, '') : null;
      const rows = watermark === null ? articleRows : articleRows.filter((row) => String(row.updated_at) >= watermark);
      return iterate(paged(rows, params.page_size ?? pageSize));
    },
    listAssetPages: (params) => iterate(paged(assetRows, params.page_size ?? pageSize)),
    vendorSearch: async () => [],
  };
}

/** An engine whose whole corpus is the staged rows, with the text budget as given. */
function engine(rows: { articles?: Row[]; assets?: Row[] }, config: Record<string, unknown> = {}) {
  return new KnowledgeSearchEngine(deps(rows), {
    pageSize: 100,
    maxIndexPages: 250,
    maxDocsScored: 2000,
    // The response budget is not what these tests are about; leaving it at its default would
    // truncate the hit list and add a `response-truncated` reason to every assertion below.
    maxResponseBytes: 1_000_000,
    ...config,
  });
}

/** 20 KiB of text budget: 10 KiB per declared long-text source (`articles`, `assets`). */
const BOUND = 20 * 1024;
const bounds = (maxIndexTextBytes = BOUND) => ({ maxDocBytes: 256 * 1024, maxIndexTextBytes, maxDocs: 50_000 });

describe('text budget: per-resource shares (issue #46)', () => {
  it('keeps article bodies when the ASSET corpus is what overflows the budget', async () => {
    // 10 articles (~8.8 KiB of body text, inside the 10 KiB article share) then 60 assets
    // (~53 KiB of custom-field text, far outside the asset share): the reporter's tenant, scaled down.
    const search = engine({ articles: articles(10), assets: assets(60) }, { bounds: bounds() });
    const result = await search.search('needlebody', { tier: 'index' });

    const stats = result.meta.index.docs;
    // The article corpus fits in its share, so NOT ONE article body may be paid for by the assets.
    expect(stats.articles?.bodiesIndexed).toBe(10);
    expect(stats.articles?.bodiesEvicted).toBe(0);
    // The asset corpus is over its limit, so the overflow is paid by the resource that caused it.
    expect(stats.assets?.bodiesEvicted).toBeGreaterThan(0);
    expect((stats.assets?.bodiesEvicted ?? 0)).toBeLessThan(60);
    // Article bodies are in memory, so the answer must not claim they are not.
    expect(result.meta.degraded).toBeNull();
    // `body-evicted` still FIRES (asset text was evicted) and is still flat: the reason reports that
    // something lost its text, `meta.index.docs.<resource>.bodiesEvicted` says which resource did.
    expect(result.meta.reasons).toContain('body-evicted');
    expect(result.meta.complete).toBe(false);

    // The observable answer, not just the counter: a body match on an ARTICLE. The scope is narrowed
    // to articles because a response keeps at most `MAX_SEARCH_LIMIT` (25) hits and the asset corpus
    // outnumbers the article corpus 6:1 - the question here is whether an article body is REACHABLE
    // at all, which the counters above would hide if the postings were wrong.
    const articleHits = await search.search('needlebody', { tier: 'index', scope: ['articles'], limit: 25 });
    const articleHit = articleHits.hits.find((hit) => hit.match.fields.includes('body'));
    expect(articleHit).toBeDefined();
    expect(articleHit?.snippet?.text.toLowerCase()).toContain('needlebody');
  });

  it('gives an assets-only tenant its whole budget, not half of it', async () => {
    // No articles at all: `limit(assets)` must be the full bound (the article share is unused), so 22
    // of these 40 ~893-byte asset texts stay in memory - 19.6 KiB held out of 20. An implementation
    // that cut a resource to its own share instead would keep ~11 and evict ~29, which this exact
    // count rules out. HEAD satisfies this too (a single resource always had the whole budget): it is
    // a REVERSIBILITY guard on the borrowing rule, not evidence for the fix.
    const search = engine({ articles: [], assets: assets(40) }, { bounds: bounds(20_000) });
    const result = await search.search('needlebody', { tier: 'index' });

    const evicted = result.meta.index.docs.assets?.bodiesEvicted ?? 0;
    expect(evicted).toBe(18);
    expect(result.meta.index.docs.assets?.indexed).toBe(40);
    expect(result.meta.index.docs.articles?.bodiesEvicted).toBe(0);
    expect(result.meta.index.docs.articles?.indexed).toBe(0);
  });

  it('evicts an article corpus that overflows its own share, and touches no asset text', async () => {
    // Articles only, over the bound: the single declared long-text source gets the whole budget, so
    // the articles evict THEMSELVES down to it (the borrowing rule must not disable self-eviction).
    // HEAD satisfies this as well: a guard that the new eligibility predicate did not turn into
    // "never evict the inserting resource", not evidence for the fix.
    const search = engine({ articles: articles(40), assets: [] }, { bounds: bounds(20_000) });
    const result = await search.search('needlebody', { tier: 'index' });

    const evicted = result.meta.index.docs.articles?.bodiesEvicted ?? 0;
    expect(evicted).toBeGreaterThan(0);
    expect(result.meta.index.docs.articles?.bodiesIndexed).toBeGreaterThan(0);
    // ~22 of the 40 ~890-byte bodies fit in 20 KiB.
    expect((result.meta.index.docs.articles?.bodiesIndexed ?? 0) + evicted).toBe(40);
    expect(result.meta.index.docs.assets?.indexed).toBe(0);
  });

  it('leaves each resource with text when BOTH corpora overflow their shares', async () => {
    // 30 articles (~27 KiB) and 60 assets (~53 KiB) against a 20 KiB budget: on HEAD the article
    // bodies pay for the asset overflow first and in full (bodiesIndexed 0). Neither corpus fits,
    // so both lose text - but neither may be emptied by the other.
    const search = engine({ articles: articles(30), assets: assets(60) }, { bounds: bounds() });
    const result = await search.search('needlebody', { tier: 'index' });

    expect(result.meta.index.docs.articles?.bodiesEvicted).toBeGreaterThan(0);
    expect(result.meta.index.docs.articles?.bodiesIndexed).toBeGreaterThan(0);
    expect(result.meta.index.docs.assets?.bodiesEvicted).toBeGreaterThan(0);
    expect(result.meta.degraded).toBeNull();
  });

  it('keeps a changed article body across an INCREMENTAL build', async () => {
    // The case that separates the share rule from the narrower "evict only from the inserting
    // resource" fallback: a re-inserted article pays for itself from its OWN resource unless the
    // other resource is the one over its limit. Here the assets hold the borrowed article share, so
    // the asset that is over its limit pays instead.
    const articleRows = articles(10);
    const assetRows = assets(60);
    const search = engine({ articles: articleRows, assets: assetRows }, { bounds: bounds(), ttlMs: 0 });
    await search.search('needlebody', { tier: 'index' });

    // One article changes and grows ~3.9x (the article walk is watermark-filtered; the asset walk is
    // not), so the re-insert alone pushes the account back over the 20 KiB bound.
    articleRows[4] = article(5, 3, `${'needlechanged '.repeat(200)}${BIG}`);
    articleRows[4].updated_at = '2026-03-01T00:00:00.000Z';
    const rebuilt = await search.search('needlechanged', { tier: 'index' });

    // The EXACT outcome, not "some body survived": the 10 bodies plus the grown one are ~12 KiB
    // against a 10 KiB article share, so the two OLDEST article bodies pay for the re-insert and the
    // other 8 - the changed one among them - stay. On HEAD all 10 bodies are gone (`bodiesIndexed 0`),
    // so a regression that lost 9 of them must fail this too.
    expect(rebuilt.meta.index.docs.articles?.bodiesIndexed).toBe(8);
    expect(rebuilt.meta.index.docs.articles?.bodiesEvicted).toBe(2);
    expect(rebuilt.meta.index.docs.assets?.bodiesEvicted).toBeGreaterThan(0);
    expect(rebuilt.meta.degraded).toBeNull();

    // ...and the changed article's OWN body is reachable through the index, which `> 0` above
    // deliberately cannot show. `needlechanged` occurs in that body only.
    const hit = rebuilt.hits.find((candidate) => candidate.resource === 'articles' && candidate.id === 5);
    expect(hit).toBeDefined();
    expect(hit?.match.fields).toContain('body');
    expect(hit?.snippet?.text.toLowerCase()).toContain('needlechanged');
  });
});
