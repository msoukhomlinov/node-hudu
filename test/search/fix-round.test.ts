/**
 * Regression pins for the PR-22 fix round (engine + store).
 *
 * Every case here FAILS on the pre-fix code and passes after it: each one is the reproduction a
 * verification sim proved (see the review run), reduced to a deterministic unit case so a revert
 * cannot stay green. The engine is driven through fake deps so a bound, a watermark window or a
 * failing vendor path is staged exactly.
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSearchEngine, type EngineDeps } from '../../src/search/engine.js';
import type { Page } from '../../src/pagination.js';
import type { KnowledgeResource } from '../../src/types/search_knowledge.js';

type Row = Record<string, unknown>;

/** `updated_at` ascends with the id, so a walk's first page is the freshest documents. */
function article(id: number, name: string, content = ''): Row {
  return {
    id,
    name,
    slug: `a${id}`,
    url: `https://hudu.example.com/articles/${id}`,
    company_id: 1,
    updated_at: `2026-01-0${id}T00:00:00.000Z`,
    content: `<p>${content}</p>`,
  };
}

/** An iterable whose first read rejects, so a build fails the way a failing endpoint does. */
function failingPages(): AsyncIterable<Page<Row>> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('vendor boom')) }),
  };
}

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

/** A latch with tickets: a caller arms it with the number of operations it should hold. */
interface Latch {
  tickets: number;
  promise: Promise<void>;
  arm: (tickets?: number) => void;
  open: () => void;
}

function latch(): Latch {
  let release: () => void = () => undefined;
  const out: Latch = {
    tickets: 0,
    promise: Promise.resolve(),
    arm: (tickets = 1) => {
      let resolve: () => void = () => undefined;
      out.promise = new Promise<void>((r) => (resolve = r));
      out.tickets = tickets;
      release = resolve;
    },
    open: () => {
      out.tickets = 0;
      release();
    },
  };
  return out;
}

interface Harness {
  corpus: { articles: Row[] };
  /** Holds the VENDOR tier (a parked search) without holding anything else. */
  vendorGate: Latch;
  /** Holds the first LIST page fetch (a parked index build) without holding anything else. */
  listGate: Latch;
  /** When true, the list endpoint fails, so a background build rejects. */
  failList: { value: boolean };
}

function harness(options: { articles?: Row[]; pageSize?: number } = {}): { harness: Harness; deps: EngineDeps } {
  const state: Harness = {
    corpus: { articles: options.articles ?? [] },
    vendorGate: latch(),
    listGate: latch(),
    failList: { value: false },
  };
  const pageSize = options.pageSize ?? 2;
  const rowsFor = (params: { page_size: number; updated_at?: string }): Row[] => {
    const watermark = params.updated_at === undefined ? undefined : params.updated_at.replace(/,$/, '');
    // Newest first (the engine's own documented index order), then the watermark window a vendor
    // `updated_at` filter would apply (inclusive lower bound).
    const sorted = [...state.corpus.articles].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return watermark === undefined ? sorted : sorted.filter((row) => String(row.updated_at) >= watermark);
  };
  const listPages = (params: { page_size: number; updated_at?: string }): AsyncIterable<Page<Row>> => {
    const size = params.page_size ?? pageSize;
    const rows = rowsFor({ page_size: size, ...(params.updated_at ? { updated_at: params.updated_at } : {}) });
    return (async function* gated(): AsyncIterable<Page<Row>> {
      if (state.listGate.tickets > 0) {
        state.listGate.tickets -= 1;
        await state.listGate.promise;
      }
      yield* iterate(paged(rows, size));
    })();
  };
  const deps: EngineDeps = {
    listArticlePages: (params) => {
      if (state.failList.value) return failingPages();
      return listPages(params);
    },
    listAssetPages: () => iterate(paged([], pageSize)),
    vendorSearch: async (resource: KnowledgeResource, query: string) => {
      if (state.vendorGate.tickets > 0) {
        state.vendorGate.tickets -= 1;
        await state.vendorGate.promise;
      }
      const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
      return rowsFor({ page_size: 100 })
        .filter((row) => terms.some((term) => String(row.name).toLowerCase().includes(term)))
        .map((row) => ({ id: Number(row.id), label: String(row.name), item: row }));
    },
  };
  return { harness: state, deps };
}

const BYTES: Record<string, number> = { small: 100000 };

describe('F1 — a CAPPED full walk must not purge documents it never reached', () => {
  it('keeps the documents outside the page cap', async () => {
    const { harness: h, deps } = harness({ articles: [1, 2, 3, 4].map((id) => article(id, `zebra ${id}`, 'alpha body')) });
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 2, maxIndexPages: 3, maxDocsScored: 2000, maxResponseBytes: BYTES.small });

    // 4 documents in 2 pages, cap 3: a COMPLETE full walk establishes the whole index.
    const first = await engine.search('zebra', { refresh: true });
    expect(first.meta.index.docs.articles?.indexed).toBe(4);

    // Four fresher documents arrive. The capped walk reads 3 pages (6 rows, newest first) and so
    // never reaches documents 1 and 2 at all.
    h.corpus.articles = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => article(id, `zebra ${id}`, 'alpha body'));
    const capped = await engine.search('zebra', { refresh: true });

    // Absence from a CAPPED walk is not a deletion: documents 1 and 2 must survive it.
    expect(capped.meta.index.docs.articles?.indexed).toBe(8);
    expect(capped.meta.index.state).toBe('partial');
    const stillThere = await engine.search('zebra one', { tier: 'index' });
    expect(stillThere.hits.some((hit) => hit.id === 1)).toBe(true);
  });
});

describe('F1 (edge) — a walk that reaches the cap on the last page has COMPLETED', () => {
  it('purges a deleted document when the remaining corpus exactly fills the page cap', async () => {
    const { harness: h, deps } = harness({ articles: [1, 2, 3, 4].map((id) => article(id, `zebra ${id}`, 'alpha body')) });
    // Cap = 2 pages of 2 rows. After the deletion the corpus is 3 documents, which the walk reads
    // in exactly 2 pages — the cap is reached on a page that reports `hasMore: false`.
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 2, maxIndexPages: 2, maxDocsScored: 2000, maxResponseBytes: BYTES.small });
    const first = await engine.search('zebra', { refresh: true });
    expect(first.meta.index.docs.articles?.indexed).toBe(4);

    h.corpus.articles = h.corpus.articles.filter((row) => row.id !== 4);
    const after = await engine.search('zebra', { refresh: true });

    // The walk saw the whole collection, so absence IS a deletion and the stale document must go.
    expect(after.meta.index.docs.articles?.indexed).toBe(3);
    const gone = await engine.search('zebra four', { tier: 'index' });
    expect(gone.hits.some((hit) => hit.id === 4)).toBe(false);
  });
});

describe('F4 — the automatic path runs the full re-walk when one is due', () => {
  it('purges a deleted document through a background warm', async () => {
    const { harness: h, deps } = harness({ articles: [1, 2, 3, 4].map((id) => article(id, `zebra ${id}`, 'alpha body')), pageSize: 10 });
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 10, maxIndexPages: 10, maxDocs: 100, ttlMs: 20, fullRefreshEvery: 1, maxDocsScored: 2000, maxResponseBytes: BYTES.small });

    await engine.search('zebra', { refresh: true });
    h.corpus.articles = h.corpus.articles.filter((row) => row.id !== 4);
    await new Promise((resolve) => setTimeout(resolve, 60)); // past ttlMs * fullRefreshEvery

    // tier 'auto' on a stale index starts a background warm: that warm is where the due full
    // re-walk has to happen, because `updated_at` cannot see a deletion.
    await engine.search('zebra', { tier: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await engine.search('zebra four', { tier: 'index' });

    expect(after.hits.some((hit) => hit.id === 4)).toBe(false);
    expect(after.meta.index.docs.articles?.indexed).toBe(3);
  });
});

describe('F-L2 — a refresh is never served by an in-flight INCREMENTAL build', () => {
  it('runs the full re-walk after awaiting the incremental one', async () => {
    const { harness: h, deps } = harness({ articles: [1, 2, 3, 4].map((id) => article(id, `zebra ${id}`, 'alpha body')), pageSize: 10 });
    // `ttlMs: 1` so the `tier: 'index'` call below is past the staleness gate and really starts the
    // in-flight incremental this case needs; a fresh index would answer without one.
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 10, maxIndexPages: 10, maxDocs: 100, ttlMs: 1, maxDocsScored: 2000, maxResponseBytes: BYTES.small });
    await engine.search('zebra', { refresh: true });

    h.corpus.articles = h.corpus.articles.filter((row) => row.id !== 4);
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.listGate.arm();
    // An incremental build is in flight and BLOCKED on the first list page.
    const incremental = engine.search('zebra', { tier: 'index' });
    const refresh = engine.search('zebra', { refresh: true });
    h.listGate.open();
    await Promise.all([incremental, refresh]);

    // An incremental cannot see a deletion: only the requested full walk can, and it must run.
    const after = await engine.search('zebra four', { tier: 'index' });
    expect(after.hits.some((hit) => hit.id === 4)).toBe(false);
  });
});

describe('F-L1 — a rebuild during the vendor await cannot re-point a scored row', () => {
  it('answers from the scored generation instead of a phantom document', async () => {
    const { harness: h, deps } = harness({ articles: [1, 2, 3, 4, 5].map((id) => article(id, `alpha ${id}`, 'alpha body')) });
    const engine = new KnowledgeSearchEngine(deps, {
      pageSize: 2,
      maxIndexPages: 10,
      // The document CAP lives in the index bounds (it is the store's bound, not a search knob).
      bounds: { maxDocBytes: 256 * 1024, maxIndexTextBytes: 64 * 1024 * 1024, maxDocs: 5 },
      maxDocsScored: 2000,
      maxResponseBytes: BYTES.small,
    });
    await engine.search('alpha', { refresh: true });

    // A fresher document that does NOT contain the first query term arrives, so a rebuild reorders
    // and caps the document array while the racy search is parked in the vendor tier.
    h.corpus.articles = [
      ...h.corpus.articles,
      { ...article(6, 'zebra only six', ''), updated_at: '2026-06-01T00:00:00.000Z' },
    ];
    h.vendorGate.arm();
    const racy = engine.search('alpha zebra', { tier: 'auto' });
    const rebuild = engine.search('zebra', { refresh: true });
    await rebuild;
    h.vendorGate.open();
    const result = await racy;

    // The whole defect was that row coordinates stayed valid only by luck: the answer must resolve
    // (no raw TypeError) and no hit may attribute another document's matched terms to a document
    // that never contained them.
    for (const hit of result.hits) {
      if (hit.id === 6) expect(hit.match.terms).not.toContain('alpha');
    }
    expect(result.hits.some((hit) => hit.id === 1)).toBe(true);
  });
});

describe('F-L1 (revision) — an in-place re-upsert cannot change a snapshot the reader holds', () => {
  it('hydrates the revision it scored, not the one that arrived during the vendor await', async () => {
    const { harness: h, deps } = harness({
      articles: [1, 2, 3, 4, 5].map((id) => article(id, `alpha ${id}`, id === 1 ? 'platypus alpha body' : 'alpha body')),
    });
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 2, maxIndexPages: 10, maxDocsScored: 2000, maxResponseBytes: BYTES.small });
    await engine.search('alpha', { refresh: true });

    h.vendorGate.arm();
    const racy = engine.search('platypus', { tier: 'auto' });
    // The SAME record is revised (its body no longer carries the term) while the racy search is
    // parked in the vendor tier: a re-upsert replaces the element the reader already scored.
    h.corpus.articles = h.corpus.articles.map((row) =>
      row.id === 1 ? article(1, 'alpha 1', 'the body was rewritten') : row,
    );
    const rebuild = engine.search('platypus', { refresh: true });
    await rebuild;
    h.vendorGate.open();
    const result = await racy;

    const hit = result.hits.find((candidate) => candidate.id === 1);
    expect(hit?.match.terms).toContain('platypus');
    // The snippet is built from the document the ROW was scored against; a snapshot that let the
    // element be replaced in place would report the revised body instead of the scored one.
    expect(hit?.snippet?.reason).not.toBe('no-match-in-body');
    expect(hit?.snippet?.text ?? '').toContain('platypus');
  });
});

describe('index metadata describes the generation its hits came from', () => {
  it('does not contradict its own snippet when a build lands during the vendor await', async () => {
    const { harness: h, deps } = harness({ articles: [1, 2].map((id) => article(id, `zebra ${id}`, 'platypus body')) });
    const engine = new KnowledgeSearchEngine(deps, {
      pageSize: 10,
      maxIndexPages: 10,
      bounds: { maxDocBytes: 256 * 1024, maxIndexTextBytes: 400, maxDocs: 100 },
      maxDocsScored: 2000,
      maxResponseBytes: BYTES.small,
    });
    await engine.search('zebra', { refresh: true }); // gen-1: both bodies are indexed

    h.vendorGate.arm();
    const racy = engine.search('platypus', { tier: 'auto' });
    // A build lands while the racy search is parked, and its arrival pushes the text budget over the
    // cap, so the LIVE index evicts the bodies the racy search already scored.
    h.corpus.articles = [
      ...h.corpus.articles,
      ...Array.from({ length: 6 }, (_v, i) => article(10 + i, `zebra extra ${i}`, 'platypus body '.repeat(8))),
    ];
    const rebuild = engine.search('zebra', { refresh: true });
    await rebuild;
    h.vendorGate.open();
    const result = await racy;

    const hit = result.hits.find((candidate) => candidate.id === 1);
    expect(hit?.snippet?.text ?? '').toContain('platypus'); // the scored generation's body
    // Reporting the LIVE index here would say "no bodies indexed" beside that snippet.
    expect(result.meta.index.docs.articles?.bodiesIndexed).toBeGreaterThan(0);
    expect(result.meta.reasons).not.toContain('body-evicted');
    // The answer still says the index has moved on since it scored.
    expect(result.meta.index.indexChangedSinceScore).toBe(true);
  });
});

describe('eviction — reported with its own signal, never as the byte cap', () => {
  it('counts the evicted bodies and tells the caller that retrying will not help', async () => {
    const { harness: h, deps } = harness({});
    h.corpus.articles = [1, 2, 3].map((id) => article(id, `zebra ${id}`, 'alpha body'));
    const engine = new KnowledgeSearchEngine(deps, {
      pageSize: 10,
      maxIndexPages: 10,
      bounds: { maxDocBytes: 256 * 1024, maxIndexTextBytes: 1, maxDocs: 100 },
      maxDocsScored: 2000,
      maxResponseBytes: BYTES.small,
    });
    const result = await engine.search('alpha', { tier: 'index' });
    const stat = result.meta.index.docs.articles;

    expect(stat?.bodiesIndexed).toBe(0);
    // Eviction is the TEXT budget's doing, so it is counted (and named) separately from the byte cap.
    expect(stat?.bodiesEvicted).toBe(3);
    expect(stat?.bodiesTruncated).toBe(0);
    expect(result.meta.reasons).toContain('body-evicted');
    expect(result.meta.reasons).not.toContain('body-truncated');
    // The advice must not promise that waiting restores what the budget took.
    expect(result.meta.degraded?.reason).toBe('body-not-indexed');
    expect(result.meta.degraded?.advice).toContain('maxIndexTextBytes');
    expect(result.meta.degraded?.advice).not.toContain('in a moment');
  });
});

describe('F6 — the response budget counts UTF-8 BYTES of the whole response', () => {
  it('flags a multi-byte payload that overshoots the budget', async () => {
    const budget = 8192;
    const { harness: h, deps } = harness({});
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 2, maxIndexPages: 2, maxDocs: 100, maxDocsScored: 2000, maxResponseBytes: budget });
    const cjk = '日'.repeat(500);
    h.corpus.articles = Array.from({ length: 8 }, (_v, index) => article(index + 1, `zebra ${cjk}-${index}`, ''));
    const result = await engine.search('zebra', { tier: 'vendor', scope: ['articles'], limit: 25 });

    expect(result.meta.bytes).toBeGreaterThan(0);
    expect(result.meta.truncation?.reason).toBe('result-limit');
    expect(result.meta.reasons).toContain('result-limit');
    expect(result.meta.complete).toBe(false);
    expect(result.meta.returned).toBe(result.hits.length);
    // `bytes` IS a field of the response it measures, so the reported value must be the size of the
    // FINAL serialisation — including the truncation notice that the budget decision adds. A notice
    // added after the last measurement would be reported as free.
    expect(result.meta.bytes).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'));
  });

  it('reports the exact size when ONE hit alone exceeds the budget', async () => {
    const budget = 1200;
    const { harness: h, deps } = harness({});
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 2, maxIndexPages: 2, maxDocs: 100, maxDocsScored: 2000, maxResponseBytes: budget });
    h.corpus.articles = [article(1, `zebra ${'日'.repeat(900)}`, '')];
    const result = await engine.search('zebra', { tier: 'vendor', scope: ['articles'], limit: 25 });

    // The first hit is always kept, so this path drops nothing: the size must still be exact.
    expect(result.hits).toHaveLength(1);
    expect(result.meta.truncation?.reason).toBe('result-limit');
    expect(result.meta.bytes).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'));
    expect(result.meta.bytes).toBeGreaterThan(budget);
  });

  it('leaves an ASCII payload of the same shape inside the budget unflagged', async () => {
    const budget = 8192;
    const { harness: h, deps } = harness({});
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 2, maxIndexPages: 2, maxDocs: 100, maxDocsScored: 2000, maxResponseBytes: budget });
    // 490 rather than the CJK case's 500: the meta carries two extra timestamps, and the point of this
    // control is the byte-per-character contrast, not the exact payload length.
    h.corpus.articles = Array.from({ length: 8 }, (_v, index) => ({
      ...article(index + 1, `zebra ${'a'.repeat(490)}-${index}`, ''),
    }));
    const result = await engine.search('zebra', { tier: 'vendor', scope: ['articles'], limit: 25 });

    // One byte per character, so the same shape fits: the budget must pass it, not truncate it.
    expect(result.meta.bytes).toBeLessThanOrEqual(budget);
    expect(result.meta.truncation).toBeUndefined();
  });
});

describe('F-L7 — a failed background build is named, not swallowed', () => {
  it('surfaces the failure in status() and in meta.errors', async () => {
    const { harness: h, deps } = harness({ articles: [article(1, 'zebra one', 'alpha')] });
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 2, maxIndexPages: 2, maxDocs: 100, ttlMs: 1, maxDocsScored: 2000, maxResponseBytes: BYTES.small });
    h.failList.value = true;

    await engine.search('zebra', { tier: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = await engine.search('zebra', { tier: 'vendor' });
    expect(engine.status().lastBuildError?.message).toContain('vendor boom');
    expect(after.meta.errors.some((entry) => entry.resource === 'index' && entry.message.includes('vendor boom'))).toBe(true);
  });
});

describe('full-walk transparency — a caller can tell an incremental warm from a full walk', () => {
  it('reports lastFullAt and fullWalkDue from the generation that produced the hits', async () => {
    const { harness: h, deps } = harness({ articles: [1, 2, 3, 4].map((id) => article(id, `zebra ${id}`, 'alpha body')), pageSize: 10 });
    const engine = new KnowledgeSearchEngine(deps, {
      pageSize: 10,
      maxIndexPages: 10,
      maxDocsScored: 2000,
      maxResponseBytes: BYTES.small,
      ttlMs: 30,
      fullRefreshEvery: 1,
    });

    // Nothing has run yet: no full walk, no complete walk, and one is due. The meta reports null too
    // (never an absent field), so a caller can read the two the same way.
    expect(engine.status().lastFullAt).toBeNull();
    expect(engine.status().lastCompleteFullAt).toBeNull();
    expect(engine.status().fullWalkDue).toBe(true);
    const cold = await engine.search('zebra', { tier: 'vendor' });
    expect(cold.meta.index.lastFullAt).toBeNull();
    expect(cold.meta.index.lastCompleteFullAt).toBeNull();
    expect(cold.meta.index.fullWalkDue).toBe(true);

    const full = await engine.search('zebra', { refresh: true });
    expect(full.meta.index.lastFullAt).not.toBeNull();
    expect(full.meta.index.lastCompleteFullAt).not.toBeNull();
    expect(full.meta.index.fullWalkDue).toBe(false);
    expect(full.meta.index.staleness).toBe('fresh');

    // An incremental warm alone cannot clear `fullWalkDue`: it never sees the whole collection, so a
    // deletion stays invisible. Waiting past ttlMs * fullRefreshEvery makes the answer say so, even
    // though `staleness` still reads `fresh` right after the build.
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.corpus.articles = h.corpus.articles.filter((row) => row.id !== 4);
    const incremental = await engine.search('zebra', { tier: 'index' });
    expect(incremental.meta.index.staleness).toBe('fresh');
    expect(incremental.meta.index.fullWalkDue).toBe(true);

    // The full walk is what makes the index see the deletion, and it clears the flag.
    const refreshed = await engine.search('zebra', { refresh: true });
    expect(refreshed.meta.index.fullWalkDue).toBe(false);
    expect(refreshed.meta.index.docs.articles?.indexed).toBe(3);
  });

  it('does not let a TRUNCATED full walk claim that the whole corpus was seen', async () => {
    // A corpus larger than the page cap: EVERY full walk is truncated, so no walk has ever seen the
    // whole collection. The scheduler clock still advances (don't re-walk on every build), but the
    // completeness claim must not.
    const { deps } = harness({ articles: Array.from({ length: 8 }, (_v, i) => article(i + 1, `zebra ${i + 1}`, 'alpha body')) });
    const engine = new KnowledgeSearchEngine(deps, {
      pageSize: 2,
      maxIndexPages: 2,
      maxDocsScored: 2000,
      maxResponseBytes: BYTES.small,
      ttlMs: 60_000,
      fullRefreshEvery: 6,
    });

    const truncated = await engine.search('zebra', { refresh: true });
    expect(truncated.meta.index.lastFullAt).not.toBeNull(); // a full walk DID run…
    expect(truncated.meta.index.lastCompleteFullAt).toBeNull(); // …but it saw only part of the corpus
    expect(truncated.meta.index.fullWalkDue).toBe(true); // so the index may still be missing records
    expect(engine.needsFullRefresh()).toBe(false); // the scheduler does not thrash on every build
  });
});

describe('F-L3 — the partial REASON belongs to the build, the partial STATE to the index', () => {
  it('stops repeating the truncated-walk reason once a build completes', async () => {
    const { deps } = harness({ articles: [1, 2, 3, 4, 5, 6].map((id) => article(id, `zebra ${id}`, 'alpha body')) });
    // `ttlMs: 1` so the `tier: 'index'` call below is past the staleness gate and really rebuilds —
    // a FRESH index answers without a walk, which is a different case (pinned in G2).
    const engine = new KnowledgeSearchEngine(deps, { pageSize: 2, maxIndexPages: 2, maxDocs: 100, ttlMs: 1, maxDocsScored: 2000, maxResponseBytes: BYTES.small });

    // Cap = 4 rows: the full walk truncates, and THAT answer says so.
    const truncated = await engine.search('zebra', { refresh: true });
    expect(truncated.meta.reasons).toContain('index-partial');
    expect(truncated.meta.index.state).toBe('partial');

    // The next build is an incremental that drains in one page: it did not truncate, so the answer
    // does not repeat the reason, while the index keeps the honest `partial` state.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const incremental = await engine.search('zebra', { tier: 'index' });
    expect(incremental.meta.reasons).not.toContain('index-partial');
    expect(incremental.meta.index.state).toBe('partial');
  });
});

/**
 * Regression pins for the v0.7.0 consumer report (iit-mcp-hudu against a live Hudu 2.45.1 tenant).
 *
 * G1 and G2 are the two defects that together made `tier: 'index'` fail on every call after the
 * first: the asset walk sent a watermark form `/assets` answers 500 to, and `tier: 'index'` rebuilt
 * on every single search so it hit that 500 constantly. Both are invisible to a mock that does not
 * assert on the REQUEST, which is how they shipped — so these cases assert on the params.
 */
interface CallLog {
  articles: { page_size: number; updated_at?: string }[];
  assets: { page_size: number; updated_at?: string }[];
}

function recordingHarness(rows: { articles: Row[]; assets: Row[] }): { calls: CallLog; deps: EngineDeps } {
  const calls: CallLog = { articles: [], assets: [] };
  const window = (all: Row[], params: { updated_at?: string }): Row[] => {
    if (params.updated_at === undefined) return all;
    const watermark = params.updated_at.replace(/,$/, '');
    // The vendor's inclusive lower bound, exactly as the comma form buys it.
    return all.filter((row) => String(row.updated_at) >= watermark);
  };
  const deps: EngineDeps = {
    listArticlePages: (params) => {
      calls.articles.push(params as CallLog['articles'][number]);
      return iterate(paged(window(rows.articles, params), params.page_size ?? 10));
    },
    listAssetPages: (params) => {
      calls.assets.push(params as CallLog['assets'][number]);
      // `/assets` answers 500 to ANY `updated_at` value carrying the trailing comma. Modelled, so a
      // revert that reinstates the filter fails here instead of only on a live tenant.
      if (typeof params.updated_at === 'string' && params.updated_at.endsWith(',')) {
        return failingPages();
      }
      return iterate(paged(window(rows.assets, params), params.page_size ?? 10));
    },
    vendorSearch: () => Promise.resolve([]),
  };
  return { calls, deps };
}

function asset(id: number, name: string, updatedAt: string): Row {
  return {
    id,
    name,
    slug: `s${id}`,
    url: `https://hudu.example.com/a/${id}`,
    company_id: 1,
    updated_at: updatedAt,
    fields: [{ label: 'Notes', value: 'alpha body' }],
  };
}

describe('G1 — the asset walk never sends a watermark `/assets` rejects', () => {
  it('re-walks assets unfiltered while articles keep the inclusive comma form', async () => {
    const { calls, deps } = recordingHarness({
      articles: [1, 2, 3].map((id) => article(id, `zebra ${id}`, 'alpha body')),
      assets: [1, 2, 3].map((id) => asset(id, `widget ${id}`, `2026-01-0${id}T00:00:00.000Z`)),
    });
    const engine = new KnowledgeSearchEngine(deps, {
      pageSize: 10, maxIndexPages: 10, maxDocs: 100, ttlMs: 1, maxDocsScored: 2000, maxResponseBytes: BYTES.small,
    });

    // A cold full walk sends no watermark for either resource, so the defect cannot fire on it.
    await engine.search('zebra', { refresh: true });
    expect(calls.articles).toHaveLength(1);
    expect(calls.articles[0]?.updated_at).toBeUndefined();
    expect(calls.assets[0]?.updated_at).toBeUndefined();

    // The INCREMENTAL build is where it fired. Articles keep the boundary re-fetch the comma buys;
    // assets carry no `updated_at` at all, because every form of it is unusable on that endpoint.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const incremental = await engine.search('zebra', { tier: 'index' });
    expect(calls.articles).toHaveLength(2);
    expect(calls.articles[1]?.updated_at).toBe('2026-01-03T00:00:00.000Z,');
    expect(calls.assets).toHaveLength(2);
    expect(calls.assets[1]?.updated_at).toBeUndefined();

    // …and the build SUCCEEDED, which is the whole point: no 500 out of `search`.
    expect(incremental.meta.errors).toHaveLength(0);
    expect(engine.status().lastBuildError).toBeNull();
    expect(incremental.meta.index.docs.assets?.indexed).toBe(3);

    // A whole-corpus asset walk on every build must not ACCUMULATE into the known total.
    expect(incremental.meta.index.docs.assets?.totalKnown).toBe(3);
  });
});

describe('G2 — `tier: index` answers a FRESH index without re-walking', () => {
  it('runs one build across two consecutive searches', async () => {
    const { calls, deps } = recordingHarness({
      articles: [1, 2, 3].map((id) => article(id, `zebra ${id}`, 'alpha body')),
      assets: [asset(1, 'widget one', '2026-01-01T00:00:00.000Z')],
    });
    const engine = new KnowledgeSearchEngine(deps, {
      pageSize: 10, maxIndexPages: 10, maxDocs: 100, ttlMs: 60_000, maxDocsScored: 2000, maxResponseBytes: BYTES.small,
    });

    // Call 1 is cold: it must build, because `tier: 'index'` still promises an index-backed answer.
    const first = await engine.search('zebra', { tier: 'index' });
    expect(first.meta.index.state).toBe('warm');
    const afterFirst = { articles: calls.articles.length, assets: calls.assets.length };
    expect(afterFirst.articles).toBeGreaterThan(0);

    // Call 2 is inside `indexTtlMs`: it answers from the index and issues NOT ONE request.
    const second = await engine.search('zebra', { tier: 'index' });
    expect(second.hits.length).toBeGreaterThan(0);
    expect(calls.articles).toHaveLength(afterFirst.articles);
    expect(calls.assets).toHaveLength(afterFirst.assets);
    expect(second.meta.index.staleness).toBe('fresh');
  });
});

describe('G3 — an asset walk stopped by the page cap is visible to the caller', () => {
  it('reports index-partial and a null asset total when only the ASSET walk truncates', async () => {
    const { deps } = recordingHarness({
      articles: [article(1, 'zebra one', 'alpha body')],
      // 6 assets at pageSize 2 with maxIndexPages 2 = 4 rows read, `hasMore: true` on the last one.
      assets: [1, 2, 3, 4, 5, 6].map((id) => asset(id, `widget ${id}`, `2026-01-0${id}T00:00:00.000Z`)),
    });
    const engine = new KnowledgeSearchEngine(deps, {
      pageSize: 2, maxIndexPages: 2, maxDocs: 100, ttlMs: 60_000, maxDocsScored: 2000, maxResponseBytes: BYTES.small,
    });

    const result = await engine.search('widget', { refresh: true });

    // The cap, not the corpus: the answer says so rather than passing 4 of 6 off as everything.
    expect(result.meta.reasons).toContain('index-partial');
    expect(result.meta.index.state).toBe('partial');
    expect(result.meta.index.docs.assets?.indexed).toBe(4);
    expect(result.meta.index.docs.assets?.totalKnown).toBeNull();
    // The ARTICLE walk completed, so its own total stays a real number — the partial state is not
    // smeared across resources.
    expect(result.meta.index.docs.articles?.totalKnown).toBe(1);
  });
});
