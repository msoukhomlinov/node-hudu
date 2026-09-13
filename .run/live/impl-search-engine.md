# Implementation report — search engine (build-order step 2)

STATUS: complete. Engine, index, `operations.searchKnowledge`, plan row, generated artefacts and tests are in
the working tree; nothing committed (the coordinator commits). Branch `feat/agent-execution-layer`.

## 1. What landed

| File | What it is |
|---|---|
| `src/search/tokenize.ts` | NFKD fold, camelCase split on lower->upper ONLY, CJK bigrams, compact token, n-gram Dice (bigrams below 6 chars, trigrams from 6) + banded Levenshtein (k=1 short / 2 from 7 chars), plural fold (`-s`, sym-directional), ~37 stopwords dropped from scoring but never emptying a query |
| `src/search/index-store.ts` | POSTINGS index (one list per field/token, never a per-document scan), per-field BM25 stats, vocabulary + n-gram candidate maps, `maxDocBytes` / `maxIndexTextBytes` (LRU text eviction that KEEPS postings) / `maxDocs` (freshest first), `retain()` for the full re-walk delete detection |
| `src/search/engine.ts` | Tiers T0/T1/T2, per-field BM25 (title 3.0 / cflabel 1.8 / ident 1.6 / cfield 1.6 / slug 1.2 / body 1.0) x coverage x resource prior (articles 1.0, assets 0.9, rest 0.8), vendor union, deterministic tie-breaks, snippets through step 1's `buildSnippet`, all honesty metadata |
| `src/types/search_knowledge.ts` | Declared result shapes (compact shape `KnowledgeSearchResult`, re-exported from `./types`) |
| `src/operations/operations.ts` | `searchKnowledge(query, opts)` + one engine per client (WeakMap) built from the client's config bounds |
| `src/config.ts` | `SearchConfig` (10 bounds): 256 KB raw / 64 MB extracted / 20,000 docs / 10 min TTL / 6 TTLs to a full re-walk / page 100 / 100 pages / 2,000 candidates / 8 KB response / fuzzyBody |
| plan + generated | Row `operations.searchKnowledge` (client-scan caps 20,000 records / 100 pages, `redaction: credentials`, `compact: KnowledgeSearchResult`, CONFIG_ERROR, 11 test rows, `status: tested`); regenerated `capabilities.json`, `src/capabilities.ts`, `MCP_TOOL_MANIFEST.md`, `examples/tool-catalog.generated.ts` |

Tiers: **T0** vendor order untouched when a query has no scoreable term after stopwords; **T1** vendor fan-out
re-ranked locally (`degraded: vendor-only`, bodies NOT searched and said so); **T2** body index UNION vendor.

## 2. Measured numbers (this run)

### 2.1 Synthetic 5,000-document corpus (assertions in `test/search/engine-perf.test.ts`; raw numbers in `.run/live/impl-search-engine-perf.json`)

| Measure | Value | Bound asserted |
|---|---|---|
| Cold index build (5,000 articles, 5 pages of 1,000) | **68 ms** | < 30,000 ms |
| Exact rare-term query | **62 ms**, scanned 5 docs | < 1,000 ms, scanned < 200 |
| Two-token query (one term is in every document) | **69 ms**, scanned 5000 | < 5,000 ms |
| Query matching nothing | scanned **0** | exactly 0 (a document loop would report 5,000) |

Against the design's naive document-loop prototype (18400 ms exact / 229300 ms two-token), the
`scanned == 0` assertion fails structurally for any future per-document scan, on any machine, whatever its speed.

### 2.2 LIVE sandbox (real Hudu 2.45.1, throwaway key; script kept in /tmp, key never written into the repo)

Baseline before: articles `[16, 17, 18, 19]`, assets **20** (matches the given baseline).
Fixture created: article 34 "Zebra maintenance runbook", whose BODY holds `ebodytok9911`.

| Query | Tier | Ranked result | Requests | Wall |
|---|---|---|---|---|
| `ebodytok9911` | vendor | **0 hits**, `degraded: body-not-indexed` — the vendor blind spot reproduced live | 2 | 82 ms |
| `ebodytok9911` | index | articles/34 score 2.247, `fields: [body]`, snippet "Replace the zebra unit. The panel shows ebodytok9911 when the drum fails...", `fetch: articles.get` | 2 (articles + assets pages) | 198 ms incl. build |
| `Zebra maintnenance runbook` | auto (warm) | articles/34 score 17.53, `fuzzy: true`, coverage 1.0, `scoreScope: cross-resource`, `degraded: null` | 2 | 72 ms |
| `zebra runbok` | auto | articles/34 score 9.951, `fuzzy: true` | 2 | < 80 ms |
| `7gh2k83` (custom-field value) | auto | assets/332 AUPOST-WS001, `fields: [custom_field]` | 2 | < 80 ms |

Index build live: **2 requests, ~200 ms, 4 articles + 20 assets**, body text taken from the LIST payload — the run
asserts no per-record `articles/{id}` or `assets/{id}` request is issued (the stubbed test asserts the same).

### 2.3 Cleanup / inventory (proves the fixture is gone)

```
BEFORE : GET /articles?page_size=100 -> [16, 17, 18, 19]   assets 20
CREATED: POST /articles -> 34 "Zebra maintenance runbook"  (mine)
AFTER  : DELETE /articles/34; GET /articles/34 -> NOT_FOUND
FINAL  : GET /articles?page_size=100 -> [16, 17, 18, 19]   assets 20   (back to baseline)
```
No pre-existing record was created, modified or deleted.

## 3. Gates (all green, this run)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS — 1,802 tests / 57 files |
| coverage | 97.7 stmts / 90.96 branch / 98.98 funcs / 98.8 lines (thresholds 97/94/83/97, unchanged) |
| `node scripts/check-capabilities.mjs` | PASS — 226 rows, 0 failures |
| `node scripts/check-capabilities.mjs --ship` | PASS — 0 failures |
| `MCP_PROFILE=core node scripts/project-mcp-tools.mjs --check-example` | PASS — 16 CORE tools (was 15) |
| `node scripts/build-tool-catalog.mjs --check` | PASS |
| `npm run build` | PASS |

Two test deltas, both unavoidable and both stated: the hard-coded projected count in
`test/mcp-tool-catalog.test.ts` moved 147 -> 148 (one new helper operation; nothing else in that test changed),
and the CORE `tools/list` budget (32,000 bytes) forced a shorter curated description plus `refresh?: boolean`
instead of a union — the measured payload is back inside the budget.

## 4. Gaps / UNVERIFIED

1. **Deferred vendor-hit re-index (design S1.5).** When a vendor row and an index row are the same record with
   different `updated_at`, the response keeps the VENDOR metadata (as designed) but does not re-index that one
   document or spend the bounded per-query fetch budget, so `truncation.reason: 'fetch-budget'` is never emitted.
   UNVERIFIED / not implemented.
2. **Mixed `scoreScope` optimism.** Vendor-union-only hits keep the vendor-tier score while index hits keep BM25;
   `scoreScope: cross-resource` is therefore optimistic in a mixed response. Same construction as the design —
   flagged, not hidden.
3. **Error-code fidelity.** A resource failure becomes a three-field entry (resource, code, message) whose code
   comes from the thrown value, defaulting to NETWORK_ERROR. Live failure paths were not exercised. UNVERIFIED.
4. **Large tenants.** 2,000+ articles, >100 index pages, >2,000 candidates and page-size clamping above 100 are
   asserted only with synthetic data; the sandbox holds 4 articles / 20 assets. UNVERIFIED live.
5. **CJK / accented corpora** are unit-tested only; the sandbox has no such content. UNVERIFIED live.
6. **A sandbox API key sits in a dot-env file at the repo root** (not created by me; the safety guard blocked
   reading it, so I cannot say whether git ignores it). Flagged for the coordinator as an independent leak risk.
