# Search engine design — fuzzy, relevance-ranked, zero-dependency

STATUS: complete (design only). Supersedes my earlier "skeleton". No file under `src/`, `test/` or `scripts/` was changed; nothing committed.
Author: engine-design agent (`.run/design/search/engine-design.md`).
Prototype: `/tmp/proto.py` (Python stand-in for the algorithm; the shipped code is TypeScript in-repo).

---

## 0. Scope, constraints, ground truth

Goal: make this node do the heavy lifting for search — surface relevant Hudu information, KB **article content
first** and **assets second**, including fuzzy matching for human-typed queries.

Hard constraints: zero runtime dependencies (any fuzzy matching is implemented in-repo), node >= 18, dual
ESM+CJS, public surface additive-only, in-memory only (no disk cache), and the existing honesty rules
(`scanTruncated`, `RESOLUTION_TRUNCATED`, "a capped search must say it was capped").

### 0.1 Ground truth established live (2026-09-12, Hudu 2.45.1, tenant `hudu-sandbox.example.com`)

| # | Fact | Evidence |
|---|---|---|
| G1 | `?search=` on **articles matches the TITLE only** — never the body, never the slug | `GET /api/v1/articles?search=kerberoasting` -> `{"articles":[]}` although article 26 body contains `kerberoasting`; `?search=zqxwvaldrin42` -> `[]`; `?search=af1899862f00` (a slug) -> `[]` |
| G2 | Article **LIST payloads already carry the full HTML `content`** | article 16 list item: `content` = 9,136 chars; no per-article GET needed |
| G3 | `?search=` on articles is a **case-insensitive, whitespace-collapsed, CONTIGUOUS substring** match, order-sensitive, no typo tolerance | `ing chec` -> hit (26); `Onboarding  checklist` -> hit; `  Onboarding checklist  ` -> hit; `Onboardng checklist` -> `[]`; `chcklist` -> `[]`; `Onboarding-checlist` -> `[]` |
| G4 | `?search=` on **assets matches the name AND custom-field VALUES** (not field labels, not `primary_serial`, not `primary_model`, not the company name) | `7GH2K83` (a Service tag value) -> asset 332; `16GB` -> 6 assets; `Service tag` (label) -> `[]`; `Australia Post` -> `[]`; `Computer assets` -> `[]` |
| G5 | Asset search is **order-sensitive and per-field**; all query terms must sit inside one value | `AUPOST 001` -> hit; `001 AUPOST` -> `[]`; `WS001 16GB` -> `[]` (name + field value) |
| G6 | `page_size` **is honoured**; the list payload is `{"articles":[...]}` with no count/meta object | `page_size=1/2/5` -> 1/2/5 items; `page=2` -> 0 items with 7 articles; response has no total field |
| G7 | `updated_at=start,end` works as a range filter | `?updated_at=2026-01-01,2026-12-31` -> 6 articles; `2025-...` -> 1 |
| G8 | One full article list page: **7 articles / 24,793 bytes / 0.12-0.14 s**; one asset page: **20 assets / 19,382 bytes / 0.15 s** | see §9 |
| G9 | No endpoint returns a relevance score or a snippet | api-docs.json has no score/rank/snippet field anywhere; all 27 MCP search tools return records |

Facts handed over by the coordinator's live inventory pass and treated as given (independently reproduced above
where marked): G1, G2, G4, and
- **G10**: a resource whose docs do not declare `search` **silently ignores it** and returns an UNFILTERED page
  (`activity_logs`, `flags`, `labels`, ...). A naive "search everything" loop therefore returns unrelated rows
  that look like matches.
- **G11**: `operations.searchAcrossResources` today has **no per-resource try/catch** — one 5xx rejects the whole
  fan-out; and it merges in fixed resource order with no ranking, no score, no snippet, no dedupe.
- **G12**: token economics — 8 articles = **15,068 bytes** as full records (11,505 of that is HTML `content`) but
  **1,299 bytes** as stripped 200-char snippets (~11.6x cheaper). Full text must come from a follow-up
  `hudu_get_article`, not from a fatter search response.

### 0.2 Where these facts changed the design

- **G1 is the whole reason the engine exists.** Vendor-first search can *never* answer a body-content query. The
  engine must own an article-body index; "vendor-filter first, then local re-rank" is therefore the *cheap tier*,
  not the answer.
- **G2 makes the body index affordable.** A cold body index is `ceil(N / page_size)` requests, not `N+1`.
- **G3 fixes the matching rules.** Local matching must be token-based and order-free, must normalise punctuation
  and whitespace, and must add edit-distance tolerance — the three things the vendor demonstrably lacks.
- **G4/G5** put assets in the same index (name + custom-field values + the fields the vendor search cannot see,
  `primary_serial`/`primary_model`/`primary_manufacturer`), but with a lower resource prior than articles.
- **G6** means the engine cannot learn "how many articles exist" from the payload; totals are only known by
  walking pages until a short page arrives.
- **G7** gives incremental refresh almost for free.
- **G10/G11** add two hard requirements: a per-resource text-filter capability table, and per-resource error
  isolation with a partial-results contract.
- **G12** caps the result shape: snippets only, plus a `fetch` pointer.

---

## 1. Ingestion and indexing

### 1.1 Source endpoints and page sizes

| Resource | Endpoint | Body/grain available on the LIST call | Notes |
|---|---|---|---|
| articles | `GET /articles?page=N&page_size=P` | full HTML `content`, `name`, `slug`, `company_id`, `folder_id`, `updated_at` | one request per page; `content` is the search grain |
| assets | `GET /assets?page=N&page_size=P` | `name`, `slug`, `primary_serial`, `primary_model`, `primary_manufacturer`, `primary_mail`, `asset_type`, `company_name`, `fields[] {label,value}`, `updated_at` | 20 assets = one page |
| companies / users / groups / websites / asset_passwords / password_folders | their list endpoints | name + a few scalar fields, no long text | index titles only, vendor filter where it exists (G10) |

Recommended request parameters:

- `page_size` = `config.search.indexPageSize`, default **100**, hard-capped at 100 (the same ceiling the helper
  tier already uses for `limit`, so there is one number to reason about).
- pages walked sequentially (never `Promise.all` across pages, matching the existing `boundedScan` rule), with the
  existing client rate-limit bucket (default 300/min) respected; bulk ingest concurrency 1 by default, 2 max.
- walk stops at a short page (`items.length < page_size`) or at `config.search.maxIndexPages` (default 100).

**Page-size clamp detection (needed because the vendor cap is UNVERIFIED beyond 100).** We cannot trust that the
vendor honours `page_size=100`. Rule: fetch page 1 with `P`; if `items.length === P`, fetch page 2 with the same
`P` and compare ids. If any id repeats, the vendor clamped `P` (it re-served the same rows) -> record
`effectivePageSize` and continue with it. Cost: one extra request, once per index build. The page-size cap in this
sandbox could not be measured above the tenant size (7 articles / 20 assets) — see §8.

### 1.2 Cache: key, contents, invalidation

- **Key**: `` `${normalisedBaseUrl}|${fnv1a32(apiKey)}|${indexVersion}` ``. `fnv1a32` is ~10 lines of arithmetic
  (no crypto dependency); the API key is never stored, only its 32-bit hash, and two different keys on one tenant
  never share a cache entry. `indexVersion` is a constant bumped whenever the tokeniser or field weights change,
  so a stale index from an older SDK build is invisible rather than subtly wrong.
- **Contents per document**: `{ resource, id, title, slug, url, company_id, company_name?, updated_at,
  bodyPlain: string | null, bodyBytes, tokensTruncated: boolean }` plus postings
  `Map<field, Map<token, { ids: Uint32Array; tfs: Uint16Array }>>` and `Map<field, Map<token, number>>` for df.
  Postings use typed arrays, not object maps: a plain object map of doc->tf is what made a naive Python prototype
  use ~79 MB of interpreter objects for 5,000 documents (§2.5), whereas two parallel typed arrays cost
  `6 bytes x postings`.
- **Invalidation**:
  1. **TTL**: `index.staleness` after `config.search.indexTtlMs` (default **10 min**); a query past the TTL still
     answers from the stale index, but sets `index.staleness: 'stale'` in the response meta — a stale answer that
     says it is stale beats an unbounded refresh on the query path.
  2. **Incremental refresh** via the `updated_at` watermark (G7): remember `max(updated_at)` seen; on refresh
     request `?updated_at=<watermark>,` and re-index only the returned documents. Typically 1 request.
  3. **Deletes are NOT observable** through `updated_at`, and the payload carries no total count (G6). So a
     **full re-walk** runs every `config.search.fullRefreshEvery` (default 6 TTLs ≈ 1 h), or on demand through
     `search.refreshIndex({ full: true })`. A full re-walk rebuilds the id set; documents missing from it are
     dropped. Nothing cheaper can honestly detect a deletion.
  4. **Explicit**: `search.refreshIndex()` (read-only helper, additive surface).

### 1.3 Memory budget for a tenant with thousands of articles

Three separate bounds, all configurable:

1. `maxDocBytes` (default **256 KB**): a document body longer than this is truncated at a word/sentence boundary;
   the document keeps `tokensTruncated: true`, and a query whose only match would be past the cut is **not found**.
   This is reported (see `index.coverage.bodiesTruncated`), never silently ignored.
2. `maxIndexTextBytes` (default **64 MB**): total cached plain text. When the budget is exceeded, the **oldest
   accessed** documents drop their `bodyPlain` but KEEP their postings and title. A hit on such a document still
   ranks correctly, but its `snippet.available` is `false` with `reason: 'evicted'`, and the caller is told to
   fetch the record. Note this is a deliberate split: postings are tiny, plain text is large. Honest consequence:
   after eviction, body recall still works, snippet quality degrades.
3. `maxDocs` (default **20,000**): above it, indexing still works but documents are indexed in `updated_at`
   descending order and the response reports `index.state: 'partial'` with `totalKnown: null`.

Arithmetic for the common case (3 KB plain text per article, ~120 distinct tokens per article, ~400 occurrences):

| Articles | Cold requests @ P=100 | Cold bytes | Cold wall time (extrapolated from G8) | Plain text | Postings (typed arrays, est.) |
|---|---|---|---|---|---|
| 200 | 2 | ~0.6 MB | ~0.3 s | 0.6 MB | ~0.05 MB |
| 2,000 | 20 | ~6 MB | ~3 s | 6 MB | ~0.5 MB |
| 10,000 | 100 | ~30 MB | ~15 s | 30 MB | ~2.4 MB |

The 2,000-article row is the realistic target: **20 requests and about three seconds, once per hour**, for
body-content search over every KB article. At the client bucket default of 300 requests/min this is far inside the
limit; the engine still serialises pages and honours the existing retry/`Retry-After` policy on 429.

### 1.4 Cheapest strategy that still answers well — three tiers

| Tier | What runs | Requests per query | Recall of a body-only term | When |
|---|---|---|---|---|
| **T0 vendor-only** | `searchAcrossResources` fan-out over the resource capability table, local re-rank of the returned rows | up to 8 (1 per resource) | **zero** (G1) | never the default for the KB-first goal; the fallback when no index exists |
| **T1 vendor-first + re-rank** | T0, then local token/fuzzy re-rank + snippet from whatever the vendor returned | up to 8 | zero | cold client, `degraded: vendor-only` |
| **T2 body index + vendor union** | local index query, UNIONed with vendor hits (so a brand-new article written seconds ago, not yet indexed, still surfaces) | 0 extra if the index is warm within TTL, else `ceil(N/100)`; + 8 for the union | **full** | default once `search.indexStatus().state === 'warm'` |

Rationale: T1 is nearly free but cannot satisfy the stated goal, because the vendor cannot see article bodies at
all (G1). T2 costs one bounded walk per TTL and then zero requests per query. The engine therefore
**auto-warms lazily**: the first body-scope query kicks off a warm build and answers from T1 meanwhile, returning
`degraded: { reason: 'no-index', advice: 'call hudu_search_knowledge again in a moment, or hudu_index_knowledge' }`
— it does not block a tool call for 15 s.

### 1.5 Freshness of an individual hit

A union of index + vendor results can return the same record twice and with two different `updated_at` values.
Union rule: key `(resource, id)`; when both sides return it, keep the **vendor** row's metadata (fresher) and the
**index** snippet/score (the vendor gives no score), and if `updated_at` differs, re-index that single document
(bound: at most 8 re-indexes per query, else mark `truncation.reason: 'fetch-budget'`).

---

## 2. Matching: an in-repo fuzzy algorithm

### 2.1 Normalisation (this is where fuzzy search actually fails in practice)

Ordered pipeline, applied once per document at index time and once per query:

1. Unicode NFKD, drop combining marks (`café` -> `cafe`, `Müller` -> `muller`).
2. Split camelCase **on lower->upper boundaries only**: `re.sub(/(?<=[a-z])(?=[A-Z])/g, ' ')`.
   *Measured failure that fixes the rule:* with the naive `(?<=[a-z0-9])(?=[A-Z])` rule the serial `7GH2K83`
   tokenises to `['7','gh2','k83']`, so `search('7gh2k84')` returned **0 hits**. After restricting the split to
   lower->upper, the same query returns asset 332. Digit-adjacent uppercase is a *code*, not a word boundary.
3. Lowercase.
4. Everything that is not a letter, digit or space becomes a space (`-`, `.`, `/`, `_`, quotes, brackets).
   This is what fixes `Onboarding-checlist` vs `Onboarding checklist` (G3).
5. Collapse whitespace, trim.
6. Tokenise on whitespace, then:
   - keep alphanumeric runs with internal digits intact (`aupost`, `ws013`, `7gh2k83`, `fortios`, `e3`);
   - a CJK run (Hiragana/Katakana/Han) becomes **character bigrams** plus the whole run if it is 1-2 chars
     (no whitespace to split on, and bigrams are the standard cheap CJK approximation);
   - emit an extra synthetic token per field: the **compact** form (all separators already removed by step 4, so
     this is the full normalised string when it is <= 32 chars). The compact token is what lets a query like
     `checklist onboarding` match a title stored as `checklist-onboarding` even when the two words were never
     adjacent in the same order. Weighted lower than a normal token.
7. Stopword list (~30 common English words) is **dropped from scoring** but retained for snippet context; if
   dropping them empties the query, the raw tokens are used instead (`not connecting vpn` must still search).

### 2.2 Stemming / plurals — what we do instead of a stemmer

We **reject** Porter/Snowball stemming. On an IT-documentation corpus it over-roots (`addresses`/`address`,
`processes`/`process`, `FortiOS`, `licences`/`license`, product codes) and it is invisible to the user when it
goes wrong. Two cheaper mechanisms replace it:

1. **Prefix matching**: a query token of length >= 3 matches any index token that starts with it, at weight 0.7.
   This covers `onboard` -> `onboarding`, `runbook` -> `runbooks`, `troubleshoot` -> `troubleshooting`.
2. **Minimal plural fold**: an index token ending in `s` with length >= 4 is also posted under its singular form
   (and vice versa), at weight 0.9. This covers `licence` -> `licences` sym-directionally, which prefix matching
   alone cannot do.

Both are *scoring* adjustments, never mutations of the stored text, so a snippet can never show a stemmed word
that is not in the document.

### 2.3 Fuzzy matching — technique, cost, and the exact gate

Chosen technique: **inverted-index candidate generation (trigram Dice) + bounded Levenshtein re-scoring** — not a
full Levenshtein scan over the corpus or the vocabulary.

```
per (field, token) posting list:
    candidates = { index tokens sharing >= 1 trigram with the query token }   # trigram map lookup
    for each candidate:
        k = 1 if len(token) <= 6 else 2
        reject if |len(candidate) - len(token)| > k
        reject if editDistance(token, candidate) > k
        reject if len(token) >= 6 and dice(token, candidate) < 0.4            # kills short-word noise
    keep the top 5 candidates by Dice
```
Edit distance is a banded DP with an early-exit when a row's minimum exceeds `k`; `k <= 2` and tokens are short,
so this never dominates.

**Scope gate (where fuzzy may look) — this is the important design decision:**

| Field | Fuzzy allowed? | Why |
|---|---|---|
| title, slug | yes, token length >= 3 | short, high-signal; typos here are the common agent failure (`VPS site to site` -> article 28) |
| asset / custom-field identifier tokens (token contains a digit) | yes | serials, part numbers, IPs, versions are exactly what humans mistype (`7gh2k84` -> `7gh2k83`) |
| body prose, token length >= 6 | yes, but behind `config.search.fuzzyBody` (default **true** for the corpus sizes in §1.3, and the flag exists so a large tenant can turn it off) | candidate generation is bounded by *vocabulary* trigrams, not by document count, so cost does not grow with N; the risk is false positives, mitigated by the Dice >= 0.4 gate and the coverage multiplier |
| body prose, token length < 6; stopwords | **no** | 3-4 letter typos generate enormous candidate sets and near-random matches |
| CJK bigrams | **no** | edit distance on bigrams is meaningless |

Measured on the synthetic 5,000-document corpus: exact-term query **4.5 ms**; two-token query scoring 975
candidate documents **310 ms**; fuzzy-only query **1.1 ms** (0 hits in that synthetic vocabulary, by construction).
The same prototype in its *first* form — which looped over every document and every field instead of driving
candidates from the postings — took **18.4 s** for one exact query and **229 s** for a two-token query. That is the
single most important implementation constraint in this document: **candidate generation must come from the
inverted index, never from a document loop.**

Complexity, with `Q` = query tokens, `V` = vocabulary size, `D` = documents, `T` = postings:

| Step | Cost |
|---|---|
| tokenise query | O(query length) |
| exact + prefix expansion | O(Q x V) worst case; O(Q x log V + matches) with a sorted vocabulary per field |
| fuzzy expansion | O(Q x trigram-bucket size x k^2) — buckets, not V |
| scoring | O(matched postings) = O(Σ df of matched terms) |
| snippet | O(body length of the top `limit` documents) |

### 2.4 Multi-word queries whose words sit in different fields

Each query token is scored **independently against every field**, and the per-token best contribution is summed.
Word order is never required (the vendor requires contiguity and order — G3/G5), so `Probe Design` and
`Design Probe` both match, and `vpn` in the title with `IKEv2` in the body is one coherent hit. A
coverage multiplier (below) keeps "all terms present" ranked above "one term present".

### 2.5 Rejected matching designs

| Rejected | Why |
|---|---|
| Full Levenshtein of each query token against every document token | O(D x tokens x len^2); measured 18.4 s / 229 s in the prototype. Candidate generation must be index-driven. |
| Porter/Snowball stemming | Over-roots technical vocabulary; destroys product codes; not explainable in a snippet. Prefix match + plural fold is cheaper and reversible. |
| Soundex / Metaphone | English-phonetic; actively harmful for `AUPOST-WS013`, `7GH2K83`, `E5`, `IKEv2`. |
| Trigram/Dice as the *only* scorer | No term weighting, no length normalisation, and a long document with many shared trigrams beats a short precise title. Used only for candidate generation. |
| Embeddings / vector search | Runtime dependency or a bundled model; breaks the zero-dependency, in-memory, dual-build constraint. |
| Relying on the vendor filter for fuzzy | The vendor has no typo tolerance at all (G3: `Onboardng checklist` -> `[]`). |
| Character n-gram index over whole documents without tokenisation | Loses field weights and snippets; huge index. |
| Indexing the raw HTML | `<code>` tags, `href` URLs and `&nbsp;` would create false tokens (`diagnose&nbsp;vpn`). HTML is stripped to plain text first, and the raw HTML is never searched. |

---

## 3. Scoring and ranking

### 3.1 Per-token score

BM25 over a per-field index, with field weights, computed from the local index's own statistics:

```
score(token t, doc d) = idf(t) * ( tf' * (k1 + 1) ) / ( tf' + k1 * (1 - b + b * len(d,f) / avgLen(f) ) )
                        * FIELD_WEIGHT[f] * matchWeight
tf'        = tf(d, t, f), floored at 0.6 when the match was a prefix or fuzzy expansion
k1 = 1.2, b = 0.75
idf(t)     = ln(1 + (N_f - df_t + 0.5) / (df_t + 0.5))      # N_f = documents with field f indexed
matchWeight: exact 1.0 | plural-fold 0.9 | compact 0.8 | prefix 0.7 | fuzzy 0.5
```

`FIELD_WEIGHT`: **title 3.0**, **custom-field label 1.8**, **custom-field value 1.6**, **slug 1.2**,
**asset ident (serial/model/manufacturer) 1.6**, **body 1.0**, **compact 0.8**.

Document-level score:

```
docScore(d) = ( Σ_t best_contribution(t, d) ) * (0.5 + 0.5 * matchedTerms/queryTerms) * resourcePrior
resourcePrior: articles 1.0 | assets 0.9 | companies/users/groups/websites/passwords 0.8
```

### 3.2 Why a huge article body cannot drown a precise title match

Three independent guards, in order of importance:

1. **BM25 term saturation.** TF enters as `tf*(k1+1)/(tf + k1*...)`, so 40 occurrences of a term in a 9 KB body
   score far less than 40x a single occurrence. A body match is worth roughly `1.0 x idf`, and extra occurrences
   add sub-linearly.
2. **Per-field length normalisation.** The length term is computed on the *field's* own average length. Titles
   average ~5 tokens here, bodies hundreds, so a title hit is not penalised by the body's length, and a body hit
   is penalised for the body's length — exactly the asymmetry that protects precise title matches.
3. **Field weights and the coverage multiplier.** Title 3.0 vs body 1.0 is a 3x prior in the title's favour, and
   `(0.5 + 0.5 x coverage)` multiplies down documents matched by only one of several query terms.

Measured: query `microsoft onboarding new starter licence` -> article 29 (title + body, coverage 1.0) scores
**27.21**; article 26 (`Onboarding checklist`, only 2 of 5 terms, coverage 0.4) scores **8.73**. The 3.1x gap is
produced by coverage and the title weight, not by document length.

### 3.3 Merging different resources into one ranked list

- **Articles first is a PRIOR, not a sort key** (`resourcePrior` 1.0 vs 0.9). A precise asset hit (serial, field
  value) still outranks a weak article body hit, which is what an operator wants when the query looks like a
  serial. If the caller passes `scope: 'articles'`, the prior is moot and only articles are scored.
- **Score comparability across resources**: `idf` comes from one shared index, all weights are absolute
  constants, and the coverage multiplier is normalised per query. The score is therefore *comparable by
  construction* inside one client+tenant, and the response says so: `scoreScope: 'cross-resource'`.
  When the index is cold (T1: vendor-only rows, no corpus statistics) `idf` is `1` per resource, the vendor's
  per-resource ranking is not a common scale, and the response must say `scoreScope: 'per-resource'` — a caller
  must not compare those numbers across resources, and the field is there so it does not have to guess.
- **Ties** break deterministically: score desc -> number of distinct matched fields desc -> title length asc
  (shorter title = more precise) -> `updated_at` desc -> `(resource, id)` asc. Determinism matters because an LLM
  consumer will otherwise see the same query return different orders and lose trust in the tool.
- **Dedupe**: key `(resource, id)`; index hit + vendor hit merge into one row (§1.5). The current
  `searchAcrossResources` does neither dedupe nor rank.

---

## 4. Output shape for an LLM consumer

```ts
interface RankedSearchResult {
  hits: RankedHit[];
  meta: RankedSearchMeta;
}

interface RankedHit {
  resource: 'articles' | 'assets' | 'companies' | 'users' | 'groups' | 'websites'
          | 'asset_passwords' | 'password_folders';
  id: number;
  title: string;                     // record name, verbatim
  score: number;                     // raw, see meta.scoreScope
  relevance: number;                 // 1.0 = best hit in THIS response; safe to display
  scoreScope: 'cross-resource' | 'per-resource';
  match: {
    fields: ('title' | 'slug' | 'body' | 'custom_field' | 'ident')[];
    terms: string[];                 // query terms that actually matched
    coverage: number;                // matchedTerms / queryTerms, 0..1
    fuzzy: boolean;                  // at least one match came from edit distance
  };
  snippet?: {
    text: string;                    // verbatim substring of the stripped source field
    spans: [number, number][];       // half-open offsets INTO `text`, never into the HTML
    source: 'article.content' | 'asset.fields' | 'title';
    truncated: boolean;              // window is not the whole field
    available: boolean;              // false when the doc was evicted / never cached
    reason?: 'evicted' | 'not-indexed';   // only when available === false
  };
  company?: { id: number; name?: string };
  updated_at?: string;
  url?: string;
  fetch: { operation: string; args: Record<string, unknown> };
  // articles -> { operation: 'articles.get', args: { id: 28 } }
  // assets   -> { operation: 'assets.get', args: { companyId: 20, id: 332 } }   // GET /assets/{id} is 404 on 2.45.1 (see §8.9)
}

interface RankedSearchMeta {
  query: string;
  terms: string[];                   // after normalisation + stopword handling
  resources: string[];
  returned: number;
  limit: number;
  complete: boolean;                 // false whenever anything below is set
  truncation?: {
    reason: 'result-limit' | 'candidate-cap' | 'index-partial' | 'fetch-budget' | 'body-truncated';
    detail: string;                  // e.g. '2,317 candidate documents exceeded maxDocsScored=2000'
    candidatesScored: number;
  };
  index: {
    state: 'cold' | 'warm' | 'partial' | 'refreshing';
    builtAt?: string; ageMs?: number;
    staleness: 'fresh' | 'stale' | 'unknown';
    docs: Record<string, { indexed: number; bodiesIndexed: number; bodiesTruncated: number; totalKnown: number | null }>;
  };
  degraded: null | { reason: 'no-index' | 'vendor-only' | 'body-not-indexed'; advice: string };
  errors: { resource: string; code: string; message: string }[];   // per-resource isolation (G11)
  timings: { vendorMs: number; localMs: number; requests: number };
  scoreScope: 'cross-resource' | 'per-resource';
  bytes: number;                     // serialised size of this response, for budget accounting
}
```

### 4.1 Snippet honesty

- `snippet.text` is **always** a slice of the document's stripped plain text. There is no summarisation, no
  partial-word reconciliation, no template. The window is chosen by maximum distinct matched terms, tie-broken by
  earliest position, expanded outward to word boundaries, capped at `snippetChars`.
- `spans` are offsets into the *returned string*. If a matched term cannot be located in the cached text (because
  the body was truncated at `maxDocBytes`, or the term matched a prefix/fuzzy expansion), `spans` is empty and
  `truncated: true` — the engine never highlights text it did not find.
- HTML is stripped before snippet extraction, so the snippet is not the byte-exact field. That is stated by
  `source: 'article.content'`, and the verbatim field is one `fetch` call away.
- The snippet is a LOSSY VIEW and says so. `fetch` is the honesty channel: `articles.get(id)` (or
  `assets.get`) returns the full record.

### 4.2 Token budget (G12)

Measured on the live tenant by the surface-design agent: 8 articles serialise to **15,068 bytes** as full records
(11,505 of them HTML `content`), versus **1,299 bytes** as stripped 200-character snippets — **11.6x cheaper**.
The MCP manifest is already ~245k tokens, so the search response must not be a record dump. Therefore:

- default `limit: 8`, `snippetChars: 200`, `maxResponseBytes: 8192`;
- when adding the next hit would exceed `maxResponseBytes`, the result stops and sets
  `complete: false`, `truncation.reason: 'result-limit'` — a shortened list that says so, never a silent cut;
- no full bodies, no full `fields` arrays, no HTML in a search response — ever. Full text is `fetch`.
- `meta.bytes` lets a caller (and the checker) assert the budget in tests.

---

## 5. Limits, truncation honesty, degradation

Bounds, all configurable under `config.search` and all reported:

| Bound | Default | Reported as |
|---|---|---|
| `limit` (hits) | 8, max 25 (throws above, matching the helper tier's no-silent-clamp rule) | `meta.limit`, `meta.returned` |
| `maxDocsScored` | 2,000 | `truncation.reason: 'candidate-cap'` + `candidatesScored` |
| `indexPageSize` | 100 | `index.docs.*.totalKnown` |
| `maxIndexPages` | 100 | `index.state: 'partial'`, `totalKnown: null` |
| `maxDocBytes` | 256 KB | `bodiesTruncated` count + `truncation.reason: 'body-truncated'` |
| `maxIndexTextBytes` | 64 MB | hits keep ranking; `snippet.available: false` |
| `maxVendorRequests` per query | 8 | `errors[]` for resources not requested |

Rules the engine must obey, inherited from the SDK's existing contract:

1. **A capped search says it was capped.** `complete: false` is set whenever any bound bit, and `truncation`
   names which one and by how much. The existing `scanTruncated` convention is the same idea; this generalises it
   from resolution to search.
2. **"No results" is never ambiguous.** A body-content query answered against an index that has zero article
   bodies indexed must return `degraded: { reason: 'body-not-indexed', advice: ... }` *alongside* an empty hit
   list. An empty list from a body-blind search is a lie by omission (G1), and it is the single most important
   honesty rule in this design.
3. **Per-resource failure isolation** (G11): every vendor call is wrapped; a failure becomes
   `errors: [{resource, code, message}]` and the remaining resources still answer. The current
   `searchAcrossResources` rejects the whole call on one 5xx and must not be copied.
4. **Never present an unfiltered page as a match** (G10): a per-resource capability table records
   `vendorTextFilter: 'search' | 'name' | 'none'`. Resources with `none` are excluded from a text query (or
   matched locally against their fetched page with an explicit `match.fields: []`, which the engine only does when
   the caller asked for that resource by name). This is what stops `search('Probe')` from "finding" rows in
   `activity_logs`.
5. **Assets and serials.** Vendor `search` does not reach `primary_serial`/`primary_model`/`primary_manufacturer`
   (G4). The engine indexes them under the `ident` field (weight 1.6) and, for a query that looks like an
   identifier, additionally offers the exact `?primary_serial=` path, which the vendor search cannot express.

Degradation ladder (each step is announced in `meta.degraded`, never silent):

| Situation | Behaviour |
|---|---|
| no index, cold client | T1: vendor fan-out + local re-rank + snippets from returned rows. `degraded: 'vendor-only'`. Body-only terms are reported as *not searched*: `truncation.reason: 'body-not-indexed'`. |
| index warm but no article bodies (`indexArticles: false`) | title/slug/asset-field matching only; `degraded: 'body-not-indexed'` |
| index warm but stale past TTL | answer from the stale index, `index.staleness: 'stale'`; refresh in the background on the next call |
| index partially built (page cap) | `index.state: 'partial'`, `totalKnown: null`; hits are real, completeness is not claimed |
| vendor call fails for a resource | hits from the other resources + `errors[]` |
| plain text evicted for a matched doc | hit stays, `snippet.available: false`, `reason: 'evicted'`, `fetch` points at the record |

### 5.1 Proposed additive surface (naming to be reconciled with the MCP surface agent)

- helper tier: `hudu.search.ranked(query, opts)`, `hudu.search.indexStatus()`, `hudu.search.refreshIndex(opts)`
- registry operations: `search.ranked`, `search.indexStatus`, `search.refreshIndex` (all `effect: 'read'`)
- MCP tools: `hudu_search_ranked`, `hudu_index_knowledge`, `hudu_index_status`
- nothing existing changes shape; `articles.search` / `assets.search` / `searchAcrossResources` keep their current
  contracts and can later delegate to the engine internally (which is where the fixes for G10/G11 belong).

---

## 6. Worked examples (real data, real prototype runs)

Prototype: `python3 /tmp/proto.py`-equivalent run (`/tmp/proto.py`, re-executed in the kernel). Corpus = the live
tenant's 4 pre-existing articles + 3 realistic articles created for this test (ids 28, 29, 30, deleted at the end
— see §9) + the tenant's 20 assets. Index: 32 documents, 951 postings, 504 vocabulary tokens.

**E1 — typo in a title word, plus word order the vendor cannot do.**
Query `VPS site to site` (user meant VPN).
- Vendor: `GET /articles?search=VPS site to site` -> `[]`. (G3: no typo tolerance; and the hyphen in the real
  title `FortiGate VPN site-to-site troubleshooting` breaks the contiguity anyway.)
- Engine: `articles/28 score=14.98 relevance=1.0 coverage=0.667 fields=['title'] match.fuzzy=true`
  (`vps` -> `vpn` by edit distance 1, gated by Dice 0.67).
- Vendor for the same intent, correctly spelled *and* order-preserved: `?search=site to site` -> hit. Order
  reversed (`?search=site site to`) -> `[]`. The engine does not care about order.

**E2 — the body-only term: the case the vendor can never answer.**
Query `E5 printer toner`. `E5` exists only in the body of the printer article.
- Vendor: `?search=E5` -> `[]`; `?search=toner` -> 1 hit (title). A query mixing both -> `[]`.
- Engine:
  ```
  articles/30  score=15.86  rel=1.0  cov=1.0  fields=[title, body]  :: Printer toner replacement and error codes
      snippet: "printer toner replacement replace the cartridge when the panel reports e5"
  articles/29  score=1.62   rel=0.102 cov=0.333 fields=[body]        :: New starter onboarding runbook (Microsoft 365)
      snippet: "…printer…"
  ```
  The body-only term is what promotes article 30 to the top, and the snippet shows *why* — with the matched span
  inside the returned string.

**E3 — a mistyped serial (assets second).**
Query `7gh2k84` (the real Service tag is `7GH2K83`, a custom-field value).
- Vendor: `?search=7GH2K84` -> `[]` (and `?search=7GH2K83` -> 1 hit; the vendor only does exact substrings).
- Engine:
  ```
  assets/332  score=2.24  rel=1.0  cov=1.0  fields=[body]  :: AUPOST-WS001
      snippet: "16gb 512gb ssd 7gh2k83 windows 11 pro …"
  ```
  Note the two normalisation fixes that make this work: the camelCase rule (so `7GH2K83` stays one token) and the
  digit-bearing fuzzy scope (so edit distance is allowed on an identifier, not only on a title).

**E4 — multi-word, multi-field, ranked.**
Query `microsoft onboarding new starter licence`. Terms land in the title (`New starter onboarding runbook`), the
body (`Microsoft 365`, `assign the E3 licence`) and a field label.
```
articles/29  score=27.21  rel=1.0   cov=1.0  fields=[title, body]  :: New starter onboarding runbook (Microsoft 365)
articles/26  score=8.73   rel=0.321 cov=0.4  fields=[title, body]  :: Onboarding checklist
```
Both are relevant; the ranking tells the reader how much to trust each one, and `coverage` is the reason.

**E5 (bonus) — body typo.** Query `kerberosting` (one dropped letter in a body-only word). Vendor -> `[]`.
Engine -> `articles/26 rel=1.0`, snippet `"…related threat technique kerberoasting"`. This is G1 and the fuzzy
gate working together, and it is the capability no existing tool in this repo has.

**Cold-search cost, same query.** On a 2,000-article tenant: first call = 20 page requests (~3 s, ~6 MB) to warm
the index, and answers `degraded: 'vendor-only'` meanwhile; every later call within the TTL = **0 vendor
requests** and 4.5-310 ms of local CPU. On the sandbox tenant (7 articles) the whole index is one request.

**Note on E4/E5.** Both ran against article 26 ("Onboarding checklist"), created by the probe sub-agent as a
body-token probe record and deleted by it afterwards. The examples are therefore not reproducible against the
current tenant without recreating that record; the mechanism they demonstrate (body-only term matching, fuzzy
body matching) is reproducible from any article whose body contains a term absent from its title, and E1-E3 use
records that were mine (28, 29) or pre-existing (332, 30 was mine).

---

## 7. Rejected designs (summary)

| Rejected | Why |
|---|---|
| Body search by asking the vendor harder (`search` on more resources, `content`-ish params) | G1: there is no body/content parameter in api-docs.json, and body tokens demonstrably never match. |
| Per-article `GET /articles/{id}` ingestion | G2 makes it unnecessary: the list already carries `content`. N+1 request pattern for zero gain. |
| Disk cache of article bodies | Zero-dependency, in-memory-only, and Hudu KB content is customer data — writing it to a temp file is a data-at-rest decision the design is not entitled to make silently. |
| Full-record search responses | G12: 15,068 bytes vs 1,299 bytes for 8 articles. Bodies belong behind `fetch`. |
| Scoring by looping over all documents | Measured 18.4 s (exact) / 229 s (two tokens) on 5,000 synthetic docs. Inverted-index candidate generation first. |
| Trusting every resource's `search` | G10: undocumented `search` is silently ignored and returns an unfiltered page — a false-match generator. |
| Reusing `searchAcrossResources`'s fan-out as-is | G11: no per-resource error isolation; one 5xx loses all resources. |
| A `score` that is only meaningful inside one response | Callers will compare across resources; the design supplies `scoreScope` and a construction that makes the numbers comparable whenever the index is warm. |

---

## 8. Open questions / UNVERIFIED

1. **Maximum honoured `page_size` above 100.** Not measurable here: the tenant has 7 articles / 20 assets, so
   `page_size=500` and `=1000` returned 7 and 20 — indistinguishable from a clamp. The clamp-detection rule in
   §1.1 handles it at runtime; a large tenant should confirm the real ceiling. **UNVERIFIED.**
2. **429 / `Retry-After` behaviour on rapid paging.** Not exercised. The engine relies on the existing retry
   policy; bulk ingest is serialised for that reason. **UNVERIFIED.**
3. **Total record counts.** No count/meta in list payloads (G6); totals are only learned by walking to a short
   page. **VERIFIED that no total is present; UNVERIFIED whether any other endpoint exposes one.**
4. **Index memory in Node.** Numbers in §1.3 are extrapolated from a Python prototype, whose object-memory
   footprint (~79 MB for 5,000 docs of postings) is not the Node figure; the design mandates typed-array postings
   precisely to avoid that. **UNVERIFIED in the target runtime.**
5. **CJK and accented-text behaviour.** The tokeniser implements NFKD folding and CJK bigrams, but the sandbox has
   no CJK or accented content to test against. **UNVERIFIED.**
6. **Cache-key inputs.** The design hashes the base URL and the API key; whether an account id is available from
   `GET /api_info` to make the key tenant-explicit was not checked. **UNVERIFIED.**
7. **Vendor `search` coverage on other resources** (users/websites/passwords) beyond the coordinator's
   `users?search=` covers name only, NOT email. **Partially verified by the inventory pass; not re-derived here.**
8. **Whether the MCP tool names proposed in §5.1 collide** with the surface-design agent's naming. Reconcile.
9. **Probe sub-agent results (live, 2026-09-12), folded in:**
   `page_size=250` and `=1000` are **accepted and not rejected** on this tenant (all rows returned); `page_size=0`
   and `=-1` fall back to the vendor default; there is **no `X-Total-Count` header and no meta object**, so a count
   needs paging until an empty page (2 calls for 21 assets). Latencies: articles `page_size=100` min/median/max =
   98/101/104 ms, `=250` 99/99/111 ms, `=1000` 100/119/137 ms; assets `=250` 136/141/158 ms. 25 rapid list calls ->
   all 200, zero rate-limit headers (no saturation test -> rate-limit behaviour stays **UNVERIFIED**).
   `GET /api/v1/assets/{id}` returns **404** on 2.45.1 — the asset fetch pointer must be
   `assets.get(companyId, id)` -> `GET /companies/{company_id}/assets/{id}` (the SDK already does this). A deleted
   article answers `GET /articles/{id}` with HTTP 200 and body `null`, which is a usable per-document
   deletion signal, but not a bulk one.


---

## 9. Evidence log (exact commands + observed output)

All requests: `GET {BASE}/api/v1/...` with header `x-api-key: <redacted>`, Hudu 2.45.1,
`https://hudu-sandbox.example.com`, 2026-09-12.

| # | Command | Observed |
|---|---|---|
| E-a | `/articles?page=1&page_size=25` | 200, `{"articles":[…7 items]}`, 24,793 bytes, 0.12-0.14 s; item 16 has `content` of 9,136 chars (G2, G8) |
| E-b | `/articles?page=1&page_size=1` / `=2` / `=5` | 1 / 2 / 5 items -> `page_size` honoured (G6) |
| E-c | `/articles?page=2` | 200, 0 items (7 articles total) (G6) |
| E-d | `/articles?search=onboarding` | `[(26,'Onboarding checklist')]` |
| E-e | `/articles?search=kerberoasting` (body-only word) | `{"articles":[]}` (G1) |
| E-f | `/articles?search=zqxwvaldrin42` (body-only token) | `[]` (G1) |
| E-g | `/articles?search=af1899862f00` (a slug) | `[]` (G1) |
| E-h | `/articles?search=ing chec` / `?search=Onboarding  checklist` / `?search=Onboarding-checlist` | hit / hit / `[]` (G3) |
| E-i | `/articles?search=Onboardng checklist` / `?search=chcklist` | `[]` / `[]` (G3, no typo tolerance) |
| E-j | `/articles?search=name=Onboarding` -> `/articles?name=Onboarding` | `[]` (the `name` filter is exact) |
| E-k | `/articles?updated_at=2026-01-01,2026-12-31` / `2025-01-01,2025-12-31` | 6 / 1 items (G7) |
| E-l | `/assets?page=1&page_size=100` | 20 items, 19,382 bytes, 0.15 s; items carry `fields[] {label,value}` and `cards` (G8) |
| E-m | `/assets?search=7GH2K83` (Service tag value) / `?search=Service tag` (label) | 1 hit (332) / `[]` (G4) |
| E-n | `/assets?search=Australia Post` / `?search=Computer assets` | `[]` / `[]` (company name and asset type are not searched) (G4) |
| E-o | `/assets?search=AUPOST 001` / `?search=001 AUPOST` / `?search=WS001 16GB` | hit / `[]` / `[]` (G5) |
| E-p | prototype on 5,000 synthetic docs (postings-driven) | build 2.09 s + finalize 0.06 s; exact query **4.5 ms**; two-token query **310 ms** (975 docs scored); fuzzy query 1.1 ms |
| E-q | prototype, first (document-loop) form | exact query **18.4 s**; two-token query **229.3 s** -> rejected design |
| E-r | `tokens('7GH2K83')` with the naive camelCase rule | `['7','gh2','k83']` -> `search('7gh2k84')` = 0 hits; after the lower->upper-only rule: `['7gh2k83']` -> 1 hit |

**Cleanup / inventory (this agent).** Articles 28, 29 and 30 ("FortiGate VPN site-to-site troubleshooting",
"New starter onboarding runbook (Microsoft 365)", "Printer toner replacement and error codes") were created by
THIS agent as a realistic test corpus for body-content search, and were deleted at the end of the run. No
pre-existing tenant data (articles 16, 17, 18, 19; assets) was modified or deleted. Final inventory in §9.1.

### 9.1 Final inventory (this agent, live tenant)

```
BEFORE any of my writes : articles [16, 17, 18, 19]                 (4 pre-existing)   assets 20
I then created (POST /articles, HTTP 200): 28, 29, 30               (test corpus, mine)
AFTER my cleanup (DELETE /articles/28, /29, /30 -> HTTP 204 each):
  GET /articles?page=1&page_size=100 -> ids [16, 17, 18, 19]        (back to the 4-record baseline)
  GET /assets?page=1&page_size=100  -> 20 assets                    (unchanged)
  GET /articles/28 (deleted)        -> HTTP 200, body `null`        (Hudu answers 200/null, not 404,
                                                                     for a deleted article)
```
Article 26 ("Onboarding checklist", the live-prober's body-token probe record) was created and deleted by the
probe sub-agent, not by me; it is the record behind E4/E5 below and no longer exists. No pre-existing tenant data
was modified or deleted. The API key was never written to a file inside the repo.
