# Proposal: fuzzy, relevance-ranked search across Hudu data (KB articles first, then assets)

Status: DESIGN PROPOSAL for approval. Nothing is implemented. Inputs: three agent documents in this directory
(`capability-inventory.md`, `engine-design.md`, `mcp-surface.md`), all evidence-based against the live sandbox
(Hudu 2.45.1) with cleanup proven (articles back to 4, assets 20).

## 1. What we can surface today, and what we cannot

Today the SDK exposes 28 search/find helper operations and 27 MCP tools. Measured live:

| Question an agent must answer | Today |
|---|---|
| Find an article by a phrase in its TITLE | yes (`articles.search`) |
| **Find an article by a phrase in its BODY** | **no** - `?search=<token only in the body>` returns `{"articles":[]}` |
| Tolerate a typo | **no** - `?search=Zephirzzq7brmp` (1 char off) -> 0 |
| Match words in any order | **no** - contiguous substring only (`Probe Design` -> 0, `esign Pro` -> 2) |
| Rank results by relevance | **no** - ids come back in ascending order, no score field |
| See WHY a record matched / a snippet | **no** - no tool returns a snippet or a score |
| Search asset custom-field values | yes (`?search=<token only in a custom field>` -> 1 hit) |
| Search asset serials / models / labels | **no** - needs exact `?primary_serial=` (`SER88` -> 0, `SER88N9X` -> 1), which `assets.search` does not expose |
| Search several resources at once | partially - `searchAcrossResources`: 8 resources, no ranking, no dedupe, and **one 5xx rejects the whole call** |

Two facts decide the architecture:

1. **The vendor cannot search KB body text, so body search must be ours.**
2. **But it is cheap: article LIST rows already carry the full HTML `content`.** A body index costs
   `ceil(N / page_size)` requests, NOT `N+1` GETs. Measured: 2,000 articles at page_size 100 = **~20 requests,
   ~6 MB, ~3 s, once per TTL** (10 min); every query after that costs **0 vendor requests**. In this sandbox:
   7 articles / 24.8 KB / 0.12 s per page.

## 2. The proposed capability

One new operation, `operations.searchKnowledge`, surfaced as ONE MCP tool `hudu_search_knowledge`.
Content-first: `articles` then `assets`.

Input (additive; no `expand` - a fatter response is not how you get more text):
    query (required)   scope? ["articles","assets"]   limit? (default 8, max 25)
    snippetChars? (default 200, max 400)   company_id?   updated_since?   min_score?   exact_only?

Result:
    hits[]  { resource, id, title, score, relevance, coverage, matched: { fields, terms },
              snippet: { text, spans, truncated, available }, fetch: <the call that gets the full record> }
    meta    { scanned, complete, reasons[], scoreScope, degraded, bytes, indexAge }

## 3. The economics that justify the shape

| | Measured |
|---|---|
| 8 articles as full records | 15,068 bytes (11,505 of it HTML `content`) |
| The same 8 as 200-char stripped snippets | **1,299 bytes** (~11x cheaper) |
| Full MCP manifest (context on what cannot ship) | 980 KB / ~245k tokens |

So the response carries snippets and a `fetch` instruction; the full body is always a follow-up `get`.

## 4. The honesty contract (the part that matters most here)

This project's rule is that a tool must never let an agent trust a partial or degraded answer. Applied to
search, that means:

- **An empty result from a body-blind search MUST say so** (`degraded: "body-not-indexed"`). A bare empty list
  would be a lie by omission - the exact failure mode as a name-only search reporting "no results" for a phrase
  that is in the body.
- **A resource whose `search` parameter is undocumented is never presented as a match.** `?search=` on
  activity_logs/flags/labels/... is silently ignored and returns an UNFILTERED page; presenting those rows as
  hits would be worse than returning nothing. The plan already declares which 8 resources have a real text
  filter (`vendorFilters`), so this is checkable - and a new checker rule should tie the two together.
- **Every bound that bites is named** (`complete: false` + `reasons[]`: result-limit, candidate-cap,
  index-partial, fetch-budget, body-truncated).
- **Snippets are verbatim slices** of the stripped field; when no span can be highlighted the spans are empty
  rather than invented.
- **Per-resource failure isolation**: one resource 5xx-ing must degrade to `failed: {...}`, not lose the call.
- **`scoreScope` declares whether scores are comparable across resources** - by construction (shared index IDF)
  when warm, `'per-resource'` when cold.

## 5. The engine (design summary)

- **Tiers**: T0 vendor-only; **T1 vendor + local re-rank** (no body recall, and says so); **T2 body index UNION
  vendor hits** (default when warm). Degradation is explicit, never silent.
- **Index**: in-memory, keyed by `baseUrl + fnv1a32 + indexVersion`, TTL 10 min with an `updated_at` watermark
  for incremental refresh. Deletes are NOT observable via `updated_at` and payloads carry no count, so a
  periodic full re-walk is required - stated honestly rather than assumed.
- **Memory bounds**: `maxDocBytes` 256 KB, `maxIndexTextBytes` 64 MB (text evicted, postings kept),
  `maxDocs` 20,000.
- **Matching**: NFKD fold -> camelCase split -> tokenise (CJK bigrams). Prefix (0.7) + plural fold (0.9) rather
  than Porter/Snowball, which was **rejected for over-rooting product codes**. Fuzzy = trigram-Dice candidate
  generation over postings + bounded Levenshtein (k=1 for len<=6, else k=2); body terms only when len>=6.
- **Scoring**: per-field BM25 (k1 1.2, b 0.75) with title 3.0 / custom-field value 1.6 / asset identifier 1.6 /
  slug 1.2 / body 1.0, multiplied by term coverage and a resource prior (articles 1.0, assets 0.9). Per-field
  length normalisation stops a 9 KB body drowning a title hit (measured 27.21 vs 8.73).
- **The single biggest implementation constraint (measured)**: naive document-loop scoring took **18.4 s** for
  one exact query and **229 s** for two tokens over 5,000 docs; the postings-driven version does **4.5 ms /
  310 ms**. The design is therefore postings-first, not "score every document".

## 6. The tool-surface cleanup (separate, optional)

The audit found the 27 search/find tools overlap badly and cost real context:
- the 8 `hudu_search_<resource>` tools are **redundant** - `hudu_search_across_resources` already accepts those
  8 resource names (only `company_id` is missing);
- **6 of the 18 `hudu_find_*` tools do not find one record** - `find_flags_by_flagable`,
  `find_labels_by_labelable`, `find_activity_logs_by_resource`, `find_expirations_by_resource`,
  `find_magic_dash_by_company`, `find_relations_by_endpoints` list ATTACHED records while their names promise a
  single identity lookup;
- proposal: **27 -> 14 tools**. This is a breaking-ish change to the agent surface and should be decided
  separately from the new search capability.

## 7. Where the two designers disagree (my recommendation)

| Point | Surface design | Engine design | Recommendation |
|---|---|---|---|
| Default result limit | 10 (max 25) | 8 (max 25) | **8** - snippets are the cost driver; a model can ask for more |
| Option naming | `snippet_length` | `snippetChars` | `snippetChars` - consistent with the SDK's camelCase options |
| Shape | one tool, one call | three tiers with explicit degradation | **both**: one tool, but its `degraded`/`scoreScope` fields expose the tier |
| Serial-shaped queries | expose an additive `{ primary_serial }` option | route identifier tokens to the exact filter | **engine's routing**, plus the additive option (cheap, and the value is already in the scanned row) |
| Response cap | token budget per tool | `maxResponseBytes` 8192 + `meta.bytes` | **engine's** - measurable and testable |

## 8. Proposed build order

1. **Engine + `operations.searchKnowledge`** (no MCP change): matching, scoring, snippets, honesty fields, with
   unit tests and live verification against the sandbox. Wire the plan/capability row; add the checker rule for
   "fan-out resource must declare a text filter".
2. **MCP tool** `hudu_search_knowledge`; regenerate the manifest and `examples/mcp-server.ts` together
   (`--check-example` WILL fail otherwise - the most likely gate break).
3. **Surface cleanup** 27 -> 14 (separate decision).
4. **Optional follow-ups**: the additive `{ primary_serial }` filter option; per-resource failure isolation in
   `searchAcrossResources`; `api_info`-based tenant cache key.

## 9. Explicitly NOT building

- No persistent/on-disk index (in-memory only; a cache directory is a deployment decision, not an SDK one).
- No new runtime dependency (fuzzy matching is in-repo; BM25, trigram-Dice and Levenshtein are all small).
- No fabricated scores or invented highlight spans.
- No server-side content search (the vendor offers none), and no pretending a name-only search covers bodies.
- No `expand` on the search tool.
- Not a general web/vector search: this is bounded lexical search with honest limits.

## 10. Open decisions for the user

1. Approve the capability and the option names/defaults above?
2. Build in the order in section 8, or start with the surface cleanup (27 -> 14)?
3. Do as a new minor release (0.4.0) with the registry/MCP changes, or land the engine first behind the
   existing tool surface?
4. Should the index be configurable (TTL, caps) through `HuduConfig`, or fixed with documented defaults?


---

## 11. Amendment (user, post-approval): two added requirements

**11.1 `hudu_search_knowledge` must PARSE HTML before it builds snippets.** Hudu article bodies are HTML
(e.g. article 16 is 9,136 bytes of markup), so a raw tag-stripped slice would surface markup fragments as the
"matched text". The extraction pipeline therefore needs real HTML handling with zero runtime dependencies:
block-level boundaries, entity decoding, whitespace collapsing, script/style removal, and a snippet taken from
the EXTRACTED text with spans into that same text. The index should store the extracted plain text, which also
changes the memory maths (the `maxIndexTextBytes` cap then covers extracted text, not raw HTML).

**11.2 COLLAPSE THE SEARCH SURFACE TO ONE TOOL - self-describing, not many descriptions.** Instead of 27 tools
(or 14), expose a SINGLE search entry point that can BOTH execute a search AND return help/resources/how-to-use
guidance on demand. Rationale: the 27 search tools are ~59 KB (~15k tokens) of MCP context that every client
pays for on every turn, while a help payload is fetched only when needed (progressive disclosure). The SDK
keeps its full helper tier (28 operations) - only the MCP projection consolidates.


---

## 12. Amendment: progressive disclosure across the whole surface (measured)

A dedicated design (`progressive-disclosure.md`) measured the status quo and proposed the mechanism:

- **Correction to section 3 above:** the 980 KB / ~245k-token figure is the MARKDOWN manifest. The
  client-visible `tools/list` payload is **147 tools = 324,688 bytes = 74,949 tokens**, and that is what a
  client pays on EVERY turn. Any policy justified by the number must use the payload figure.
- **The mechanism:** a **16-tool always-present CORE (~6,294 tokens, -91.6%)** plus **3 meta tools**
  (`hudu_catalog`, `hudu_describe`, `hudu_invoke`) that make **all 225 registry operations reachable on
  demand**. A 20-turn session drops from ~1.50M tokens to ~126k. A catalog of all 225 operations is 10,161
  tokens (1,772 per 40-row page; 46/row); a `describe` call is ~180 tokens median. Tier/profiles are an
  optional host knob; a dispatcher is the escape hatch, never the only tool.
- **Reachability is the strongest argument:** with today's flat surface **78 of 225 operations are unreachable
  from any MCP client** (22 by projection rule, 56 by curation), and no core/extended tier annotation is
  actually populated (0 tier overrides) - so the "tier" language is aspirational. Progressive disclosure is
  what makes that latent capability reachable at all.
- **The unsound corner, flagged rather than hidden:** `hudu_invoke` needs a validator that knows the
  generator's schema language - a SECOND implementation of it. Without a gate that enumerates and tests every
  shape (their G4), validation can silently no-op. Safety must come from the SDK's existing guards (dry-run,
  approval, bounds, redaction), never from the shorter tool list.
- **Most likely break:** `mcp:project --check-example` fails as soon as the meta tools register, because they
  are not curated manifest tools. Fix: META override records, or a `--profile core` projection mode.
- UNVERIFIED by that design: any host's `tools/list` filtering or list-changed behaviour (a projection cannot
  control the server).


---

## 13. Amendment: the single search tool, and a correction to my own token claim

Design: `single-search-tool.md`. The tool is `hudu_search` (backing operation stays
`operations.searchKnowledge`) with one optional `mode` enum = `search | help | resources`, defaulting to
`search`. Mode confusion is designed against, not hoped away:
- a missing `query` in search mode is a `CONFIG_ERROR` - it NEVER silently falls back to help;
- a field the current mode cannot honour is a `CONFIG_ERROR` naming the honoured fields - never silently ignored;
- each mode returns a distinct top-level shape with the mode echoed back.
("Omit the query to get help" was explicitly rejected as ambiguity by omission.)

**CORRECTION - the token saving is far smaller than this proposal implied.** Measured:

| | Bytes |
|---|---|
| Today's 27 search tools (section / wire-compact / wire-full) | 59,238 / 31,063 / 52,176 |
| ONLY the 9 retireable ones (8 `search_<resource>` + `search_across_resources`) | 19,407 / 9,725 / 17,039 |
| The new `hudu_search` tool (always on) | 3,383 |
| **Net saving** | **6,342 (~1,586 tokens) compact / 16,107 section** |

So the honest figure is **~1.6k tokens, not the ~15k implied earlier** - reaching 15k would require also folding
the 18 `hudu_find_*` identity lookups into the search tool, which would LOSE capability (search cannot replace
an exact email/domain/serial lookup). Break-even is 1.8 help fetches.

**The real justifications are therefore:** (a) one decision point instead of three overlapping ones, and
(b) the manifest being unshippable whole - not a large per-turn saving. The large per-turn win is the
progressive-disclosure CORE (-91.6%), not this consolidation.

Migration: 147 -> 139 projected tools - the 9 search tools become 1; the 12 genuine `find_*` lookups keep their
names; the **6 misnamed `find_*` list-tools are renamed to `hudu_list_*_for_*`** (they list attached records, so
their old names lied); `get_*`/`create_*` are untouched; the SDK's 28 search/find helper operations are
unchanged. `examples/mcp-server.ts` loses 6 registrations and gains `hudu_search` (header 20 -> 15).

Gate: one composite plan row (both resolution caps, `redaction: credentials`, 10 tests including one per mode),
+4 overrides, +1 `annotations.bounded`, +9 `exclude`. Four new rules are proposed -
`searchable-resource-parity`, `help-mode-documents-resources`, `mode-honours-fields`, `prose-dangling-projection`.
**Warning carried forward:** `prose-dangling-projection` cannot ship as a hard failure - 48 surviving sections
name the tools this change retires and 59 already name tools absent from the projection, so it must be scoped
(e.g. only over text this change touches), or the prose must be cleaned first.


---

## 14. Final reconciled plan (all six designs landed)

Six documents now agree on the architecture. The one thing they changed about the original brief: **the
context win comes from progressive disclosure, not from the search consolidation** (see section 13).

### 14.1 New vendor behaviour found while designing the extractor (measured)

Writing an article MUTATES its HTML: the vendor decodes entities (`&nbsp;` -> U+00A0, `&mdash;` -> em dash),
re-escapes bare `&` (`&foo;` -> `&amp;foo;`), **ingests inline base64 images to `/public_photo/<id>`**, DELETES
CDATA, auto-closes unclosed tags and inserts block newlines - but **keeps `<script>`/`<style>` verbatim**.
So the extractor must BOTH decode entities and drop raw script/style, and it must not assume what it sent is
what it stored. (Side finding: article writes can create public_photo rows, which explains extra rows in that
resource.)

### 14.2 The pipeline, as designed and measured

| Stage | Design | Evidence |
|---|---|---|
| Extract | single O(n) character scan, no tag regex: block elements -> newline, table cells -> space, inline -> nothing, raw-skip `script`/`style`/`head`/`svg`, `pre` keeps line breaks, unknown entities stay literal | 0.216 ms for a real 9.1 KB article, ~24 ms/MB, worst adversarial 200 KB case 4.2 ms |
| Why not regex | a tag regex **leaks script bodies**, mishandles `if (1<2)` (silent content loss) and glues cells together (`Low EndFortiGateRugged-35D` vs `Low End FortiGateRugged-35D`), which kills every phrase crossing an element boundary | measured against real markup |
| Index | extracted text is **0.47-0.49x** the raw HTML (9,136 -> 4,268 bytes), so the 64 MB `maxIndexTextBytes` cap still covers ~20,000 typical articles and stays consistent with `maxDocs` 20,000; `maxDocBytes` 256 KB stays on RAW, plus a new `maxOutChars` | cold-build extraction for 2,000 articles ~0.3 s, ~10% of the page walk |
| Match/score | postings-first: trigram-Dice candidates + bounded Levenshtein, per-field BM25 (title 3.0 / custom-field 1.6 / asset ident 1.6 / slug 1.2 / body 1.0) x coverage x resource prior | naive doc-loop scoring measured 18.4 s (exact) and 229 s (2 tokens) over 5,000 docs; postings-driven 4.5 ms / 310 ms |
| Snippet | `text` is EXACTLY `extracted.slice(textStart, textEnd)` - ellipsis lives in `truncated.before/after`, never in the text; `spans` are absolute UTF-16 offsets into the extracted text, merged on overlap, capped at 8, with `omittedSpans` counted | **300/300 terms verified for slice equality AND span read-back equality** |
| Honesty | the snippet is DERIVED text and the offsets do NOT apply to the raw `content` (raw HTML is a follow-up `get`); a title-only match returns `available: false` with empty spans rather than a fabricated highlight | - |

### 14.3 The agent-facing surface

- **`hudu_search`** - one tool, optional `mode` = `search | help | resources` (default `search`), refusing
  ambiguity by construction: a missing `query` in search mode is a `CONFIG_ERROR`, never a silent help
  fallback; a field the mode cannot honour is a `CONFIG_ERROR` naming the honoured fields; each mode returns a
  distinct shape with the mode echoed.
- **Progressive disclosure** - a **16-tool always-present core (~6,294 tokens, -91.6%)** plus **3 meta tools**
  (`hudu_catalog`, `hudu_describe`, `hudu_invoke`) that make all 225 registry operations reachable on demand.
  This is the change that matters for context: a 20-turn session falls from ~1.50M to ~126k tokens.
- **Reachability** - today **78 of 225 operations are unreachable from any MCP client** (22 by projection rule,
  56 by curation) with 0 tier overrides populated; the meta tools are what expose them.
- Search consolidation alone saves only ~1.6k tokens (9 retireable tools), so it rides along rather than
  leading.

### 14.4 Build order (each step gated, each step shippable)

1. **Extractor + snippet pipeline** (`src/search/html.ts`, `src/search/snippet.ts`) - pure, unit-testable,
   no engine dependency. Gate: the 300/300 slice-and-span property test, the naive-regex counter-examples as
   regression cases, and the adversarial 200 KB timing bound.
2. **Engine + `operations.searchKnowledge`** - tokeniser, postings, fuzzy candidates, BM25, tiers T0/T1/T2,
   in-memory index with TTL + `updated_at` watermark, honest `complete`/`reasons`/`degraded`/`scoreScope`.
   Gate: plan row (both resolution caps, `redaction: credentials`), perf bound (postings-first, with the
   18.4 s naive path as an explicit anti-regression note), live verification against the sandbox.
3. **`hudu_search` MCP tool** + the 9-tool retirement and the `hudu_list_*_for_*` renames. Gate:
   `--check-example` regenerates `examples/mcp-server.ts` (20 -> 15 registrations), plus the new rules
   `searchable-resource-parity`, `help-mode-documents-resources`, `mode-honours-fields`.
4. **Progressive disclosure** - core set + 3 meta tools + generated catalog. Gate: every unexposed operation
   reachable (catalog-minus-core subset proof with a negative fixture), `hudu_invoke` validating against the
   registry record with a shape-enumeration test (the agent's G4 - without it, validation silently no-ops),
   dry-run forced on writes and destructive operations refused without a confirmation flag.
5. **Optional**: the additive `{ primary_serial }` filter option; per-resource failure isolation in
   `searchAcrossResources` (today one 5xx loses the whole call).

### 14.5 Known unknowns (stated, not hidden)

Asset custom-field snippets (the `field:Label` path - the row shape `{id,label,value}` IS verified); CJK/Thai
folding; whether the Trix editor preserves `<script>` the way a direct API write does; any MCP host's
`tools/list` filtering or list-changed behaviour (a projection document cannot control the server); and the
`prose-dangling-projection` rule, which cannot ship as a hard failure until the 48 sections naming retired
tools and the 59 naming unprojected tools are reconciled.

### 14.6 What this does NOT include

No persistent/on-disk index; no new runtime dependency; no vector/embedding search (lexical + fuzzy only);
no fabricated scores or invented highlight spans; no `expand` on the search tool; no folding of the 18
identity `find_*` lookups into search (that would trade capability for a number we have now measured
correctly).
