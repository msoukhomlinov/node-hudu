/**
 * Performance bound — the reason the engine is postings-first.
 *
 * The design of record measured a document-loop scorer at 18.4 s for ONE exact query and 229 s for
 * a two-token query over 5,000 documents, against 4.5 ms / 310 ms for the postings-driven form.
 * The bounds below are deliberately generous (they are a regression fence, not a benchmark): a
 * future change that reintroduces a per-document scan cannot pass them, and the `scanned`
 * assertions fail even on a fast machine, because a document loop touches every document by
 * definition.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { KnowledgeSearchEngine, type EngineDeps, type VendorRow } from '../../src/search/engine.js';
import type { Page } from '../../src/pagination.js';

type Row = Record<string, unknown>;

const DOCS = 5000;
/** Documents that contain the rare term: 5 of 5,000, so a hit list is real but the candidate set is tiny. */
const RARE = 5;

function corpus(): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= DOCS; i += 1) {
    const rare = i <= RARE ? ' zzneedleword ' : ' ';
    rows.push({
      id: i,
      name: `Runbook ${i}`,
      slug: `runbook-${i}`,
      updated_at: '2026-01-01T00:00:00.000Z',
      content: `<p>standard operating procedure ${i}${rare}widget replacement steps for device ${i}</p>`,
    });
  }
  return rows;
}

async function* iterate(pages: Page<Row>[]): AsyncIterable<Page<Row>> {
  for (const page of pages) yield page;
}

function deps(rows: Row[]): EngineDeps {
  const pages = (pageSize: number): Page<Row>[] => {
    const out: Page<Row>[] = [];
    for (let i = 0; i < rows.length; i += pageSize) {
      out.push({ items: rows.slice(i, i + pageSize), page: out.length + 1, page_size: pageSize, hasMore: i + pageSize < rows.length });
    }
    return out;
  };
  return {
    listArticlePages: (params) => iterate(pages(params.page_size ?? 1000)),
    listAssetPages: () => iterate([]),
    vendorSearch: async (): Promise<VendorRow[]> => [],
  };
}

describe('knowledge search performance', () => {
  it('keeps query latency postings-driven over 5,000 documents', async () => {
    const engine = new KnowledgeSearchEngine(deps(corpus()), { pageSize: 1000 });
    const buildStarted = Date.now();
    await engine.warm({ full: true });
    const buildMs = Date.now() - buildStarted;

    const exactStarted = Date.now();
    const exact = await engine.search('zzneedleword', { tier: 'index' });
    const exactMs = Date.now() - exactStarted;

    const twoStarted = Date.now();
    const two = await engine.search('zzneedleword widget', { tier: 'index' });
    const twoMs = Date.now() - twoStarted;

    // A term that exists in no document must generate NO candidates. A per-document scan would
    // report every document here, whatever the machine's speed.
    const unmatched = await engine.search('zzqzxqzx', { tier: 'index' });

    const status = engine.status();
    const measurements = {
      documents: DOCS,
      buildMs,
      exactMs,
      twoTokenMs: twoMs,
      exactScanned: exact.meta.scanned,
      twoTokenScanned: two.meta.scanned,
      unmatchedScanned: unmatched.meta.scanned,
      exactHits: exact.hits.length,
      twoTokenHits: two.hits.length,
      assertions: 'exactMs < 1000, twoTokenMs < 5000, buildMs < 30000, scanned < 200',
      naiveDocumentLoopMs: { exact: 18_400, twoToken: 229_300 },
    };
    mkdirSync('.run/live', { recursive: true });
    writeFileSync('.run/live/impl-search-engine-perf.json', JSON.stringify(measurements, null, 2));

    expect(exact.hits.length).toBeGreaterThan(0);
    expect(two.hits.length).toBeGreaterThan(0);
    expect(exact.meta.index.docs.articles?.indexed).toBe(DOCS);
    expect(status.state).toBe('warm');
    // A document loop scores every document; postings-driven scoring touches only matched documents.
    expect(exact.meta.scanned).toBeLessThan(200);
    expect(unmatched.meta.scanned).toBe(0);
    expect(unmatched.hits).toEqual([]);
    expect(exactMs).toBeLessThan(1000);
    expect(twoMs).toBeLessThan(5000);
    expect(buildMs).toBeLessThan(30_000);
  });
});
