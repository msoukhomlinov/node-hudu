# The agent-facing MCP search surface — design proposal

STATUS: design/brainstorm. No file under `src/`, `test/` or `scripts/` was changed. Nothing committed.
Everything below was grounded on the live sandbox (real Hudu **2.45.1**, `hudu-sandbox.example.com`)
unless a line is marked **UNVERIFIED**.

All probes ran against the vendor API directly with `x-api-key` (base `https://hudu-sandbox.example.com/api/v1`),
and through the built SDK (`dist/index.js`, which is newer than the current `src/`) where the question was
about SDK behaviour. Scratch scripts: `/tmp/probe1.mjs`, `/tmp/probe2.mjs`, ad-hoc Python `requests`.

---

## 0. Headline: the vendor cannot search KB article content, and nothing ranks

| Probe (exact command) | Observed output | Meaning |
|---|---|---|
| `GET /articles?search=quuxploverbananazzq7brmp&page_size=10` | `200` `n=0` | token present **only in the article body** → **no match** |
| `GET /articles?search=Zephyrzzq7brmp&page_size=10` | `200` `n=1` `ids=[31]` | same article, token in its **name** → match |
| `GET /articles?search=Zephirzzq7brmp&page_size=10` | `200` `n=0` | one-character typo → **no fuzzy tolerance** |
| `GET /articles?search=brmp&page_size=10` | `200` `n=1` `ids=[31]` | mid-word substring matches (case-insensitive) |
| `GET /articles?search=runbook Zephyrzzq7brmp&page_size=10` | `200` `n=0` | reordered multi-word → no match; matching is **contiguous substring** |
| `GET /articles?search=zzzznothingatallhere&page_size=10` | `200` `{"articles":[]}` | honest empty, not an error |
| `GET /assets?search=SNZZQ7BRMP` (asset 363, `primary_serial="SNZZQ7BRMP"`) | `200` `n=0` | **serial is not searchable** |
| `GET /assets?search=verwordzzq7brmp` (same asset, a custom-field **value**) | `200` `n=1` `ids=[363]` | custom-field **values** are searchable |
| `GET /assets?search=Version` (the custom field **label**) | `200` `n=0` | labels are not searchable |
| `GET /assets?search=Wombat laptop` | `200` `n=1` | asset name, substring |
| `GET /articles?page_size=100` | order `[16,17,18,19,28,29,30,31]` (id ascending) | `search=probe` returned `[25,27,31]` = **id order, no relevance ranking, no score field anywhere** |

Consequences, in one sentence each:

1. **Content search must be client-side.** The vendor's `search` never sees `content`. "KB content first"
   therefore means the SDK fetches full article records (each carries `content`) and matches locally under
   the existing bounded-scan caps. It cannot mean "forward `search` and hope".
2. **Ranking must be client-side.** The vendor returns matches in id order and no row carries a score, so
   any relevance number is ours to compute and to document.
3. **Fuzzy matching must be client-side and dependency-free** (trigram / bounded Damerau-Levenshtein in-repo).
4. **`primary_serial` is not searchable**, which is why the `hudu_find_*_by_*` family is load-bearing — a
   future content-ranked search must not retire those.

Measured payload sizes on this tenant (8 articles / 20 assets / 23 companies — small, shared with other agents):

| Measurement | Bytes |
|---|---|
| 8 articles as full records (JSON) | 15,068 |
| …of which `content` HTML | 11,505 |
| 8 articles as compact `ArticleSummary` rows | 1,589 |
| 8 × 200-char HTML-stripped snippets (proposed shape) | 1,299 |

A snippet-bearing ranked tool is therefore ~**11× cheaper** than making the model read expanded records —
which is the whole reason to put the snippet in the search tool instead of telling agents to `expand: true`.

---

## 0b. Coordinator steering — where it changes this design

The coordinator supplied live findings from the inventory agent. All six were re-confirmed here against the
same tenant, so they are treated as given. **Where each one changes this document:**

| Steering fact | Confirmed here | What it changes |
|---|---|---|
| 1. `search` never matches article body content | yes — my own body-only token probe (`quuxploverbananazzq7brmp`) returned `{"articles":[]}`; the name token returned 1 | Nothing to re-decide: §0 already makes client-side content matching mandatory. It is now a **two-source** fact, not one. |
| 2. Article LIST payloads already carry full HTML `content` (100-article page = 8 records / 26 KiB / 0.11 s) | yes — `GET /articles?page_size=100` returned 8 records, 15,068 B of JSON of which 11,505 B was `content`, and my probe article 31 was present in that page with its body | **Design made cheaper.** The content scan needs **no per-article `GET`** — one bounded page read per resource yields every body. My §2 scan budget (500 records / 4 pages) is unchanged, but the cost model is now a small number of list calls, not N+1 gets. This also settles the 8-vs-10 count I saw twice: the tenant holds 8 articles (25 and 27 were removed by another agent mid-session). |
| 3. `search` reaches asset custom-field **values** but NOT `primary_serial`/`primary_model`/`primary_mail`/`primary_manufacturer`, field labels, or company name; the exact `?primary_serial=` filter exists but `assets.search` does not expose it (`SER88` → 0, `SER88N9X` → 1) | yes — `?search=verwordzzq7brmp` (field value) → 1 hit; `?search=SNZZQ7BRMP` (the asset's own serial) → 0; `?search=Version` (label) → 0 | **Adds a routing rule I had not specified.** The ranked helper must classify a query token that looks like a serial (`[A-Z0-9-]{4,}`, mixed alphanumeric with no spaces) and route it to the vendor `primary_serial` filter rather than to the fuzzy scorer, and it must read `primary_serial` off the record it already scanned for the local pass (the value is in the payload, so no extra call). Adding that filter to `assets.search` is an **additive** SDK change (`{ primary_serial?: string }`) and is the cheapest single search upgrade available. |
| 4. Uniform semantics: case-insensitive **contiguous substring**, no word boundaries, word order matters, no typo tolerance; `name=` is exact-case-insensitive; `users?search=` covers name only, **not email** | yes — `brmp` matched mid-word, reordered `runbook Zephyrzzq7brmp` matched 0, `Zephir…` matched 0 | Confirms the scorer design in §2. **New local-match duty:** because `users?search=` ignores email, the in-repo pass must also match `email` locally on the rows it already has (same for `slug`, which is in every row). Cheap, and it removes a class of false "no results". |
| 5. `?search=` on a resource that does not document the parameter is **silently ignored** and returns an **unfiltered page** | yes, and this one matters most: `activity_logs?search=zzzznothingatallhere` → **100 rows**, identical to the unfiltered page; `expirations` → 3 (same as unfiltered); `lists` → 1 (same); `folders` → 1 (same). The 8 in scope all honour it: `activities`… `articles`/`assets`/`companies`/`groups`/`users`/`websites`/`asset_passwords`/`password_folders` with the same garbage query → **0** | **Adds a hard rule and shows the table already exists.** The registry already records exactly this: `capabilities.plan.json` sets `search: "search"` and lists `search` in `vendorFilters` for **precisely** those 8 resources (`articles.list`, `assets.listAcrossCompanies`, `companies.list`, `asset_passwords.list`, `groups.list`, `password_folders.list`, `users.list`, `websites.list`) and for nothing else. So the per-resource text-filter table is **not new machinery**: the ranked helper must derive its searchable set from the plan/registry `search` field, and must reject (or locally filter) any resource whose row has no `search`. Never infer "this resource is searchable" from a live call that returned rows. |
| 6. `searchAcrossResources` today: 8 resources, no ranking/dedupe/score/snippet, hit shape `{resource,id,label,item}`, and **no per-resource try/catch** so one 5xx rejects the whole call | consistent with the code (`SEARCH_HELPERS`, `boundedMap`) — not re-probed | **Adds a robustness requirement to §2/§4.** The new ranked helper must isolate per-resource failures and report them (`failed: {"articles": "RATE_LIMIT"}`) instead of failing the whole query, and `hudu_search_across_resources` should gain the same treatment. Live support for the risk: `ip_addresses`, `vlans` and `networks` return **HTTP 400** for a plain `GET /<resource>?page_size=100` — a resource that fails like that inside a fan-out kills the whole call today. |

### The one rule this adds to the design (hazard 5, stated for the checker)

A search tool may only claim a match from a resource whose registry row documents a text filter. Concretely:
`operations.searchKnowledge` derives `searchableResources` from the plan rows where `search === "search"`, and
`hudu_search_across_resources` must keep its resource list exactly equal to that set. Any future resource
added to either list without a `search` vendor filter returns an **unfiltered page** for every query — rows
that look like matches and are not. That is a silent-wrong-answer class of bug, so it belongs in
`scripts/check-capabilities.mjs` as a new rule: *a helper whose fan-out names resource R must have R's list
row declaring a text filter, or the helper must declare that it filters R client-side.* Today's 8 happen to
satisfy it by construction; nothing in the gate enforces it.

---

## 1. Audit: what an LLM actually sees today

The 27 search/find tools are **59,286 bytes** of manifest text (≈15k tokens) — the 8 single-resource
`hudu_search_<resource>` tools are **17,479 B**, the 18 `hudu_find_*` tools are **39,863 B**, and
`hudu_search_across_resources` is **1,944 B**. The full manifest is 980 KB (≈245k tokens for 147 tools),
so the tool list is **already over budget and cannot be shipped whole**; the manifest itself says
"147 projected tools is a projection, not a shipped tool list ... tiering (core / extended) and trimming
are curation". Any proposal that adds a tool without retiring tools makes that worse.

The 27 split into three families, and the families are not what their names say.

**Family A — 8 × `hudu_search_<resource>` (`articles`, `assets`, `asset_passwords`, `companies`, `groups`,
`password_folders`, `users`, `websites`).** All eight have the identical shape
`{query, opts {limit, expand, company_id?}}`; `hudu_search_across_resources.resources` accepts exactly the
same eight names. **They are redundant**, with one real gap: `across_resources` has **no `company_id`**,
which the four scoped searches do have.

**Family B — 12 identity lookups by key** (`find_articles_by_slug`, `find_asset_passwords_by_slug`,
`find_assets_by_serial`, `find_companies_by_domain`, `find_companies_by_slug`,
`find_ip_addresses_by_address`, `find_lists_by_name`, `find_matchers_by_sync_id`,
`find_networks_by_address`, `find_users_by_email`, `find_vlans_by_vlan_id`, `find_websites_by_slug`).
These are **exact-key resolution**, and the live probes prove the vendor search cannot replace two of them
(`primary_serial`, field labels). Keep all twelve. Two description defects an agent will hit:
- `hudu_find_matchers_by_sync_id` requires **two** required args (`syncId` **and** `integrationId`) — its
  name promises a single-key lookup. Misleading.
- `hudu_find_assets_by_serial`'s `preferredWhen` tells the model to prefer `assets.listAllAcrossCompanies`
  — **a tool that is never projected** (`listAll` is excluded by rule 2). The model is told to prefer a
  tool it cannot call. The `prose-dangling` checker rule does not catch this: it verifies the *client* has
  the method, not that the *projection* exposes it. That is a checker gap, not just a description bug.

**Family C — 6 that are not identity lookups at all:** `find_activity_logs_by_resource`,
`find_expirations_by_resource`, `find_flags_by_flagable`, `find_labels_by_labelable`,
`find_magic_dash_by_company`, `find_relations_by_endpoints`. Their descriptions begin *"List the …"* and
they return **lists of attached records**, but their names say `find_*_by_*`, which in this surface means
"resolve exactly one record". An agent planning "find the record whose key is X" will read
`hudu_find_labels_by_labelable` as that, and get a list.

### The agent's actual decision problem

For the query *"find the VPN runbook"* an agent sees `hudu_search_articles`,
`hudu_search_across_resources`, `hudu_find_articles_by_slug` and must choose. Nothing in any of the three
descriptions says **what is searched**. `hudu_search_articles` says "Search knowledge-base articles by a
free-text query. Preferred over articles.list for any text search" — a model reading that will reasonably
conclude that a body-only phrase would be found. It will not be. The single most important fact for this
whole feature is an *omission*, so a model will answer "no results" for content that exists and will
trust that answer.

### Proposed minimal coherent set: 27 → 14 tools (−13, −48%)

| Action | Tools | Count |
|---|---|---|
| **Add** | `hudu_search_knowledge` (new, §2) | +1 |
| **Keep, re-scope** | `hudu_search_across_resources` — add `company_id`; description states "exact substring on names/field values, **never** article bodies" | 1 |
| **Keep** | the 12 identity lookups (Family B) — they answer what search cannot | 12 |
| **Retire** | the 8 `hudu_search_<resource>` (`exclude: true` overrides, reason: covered by `hudu_search_across_resources` + `company_id`) | −8 |
| **Rename** | the 6 Family-C tools to `hudu_list_<child>_for_<owner>` (`hudu_list_labels_for_record`, …) | −0 |

Net tool count: 1 + 1 + 12 = **14** (from 27). Description bytes for the search family drop from 59,286 B
by at least the 17,479 B of the retired tools (~4.4k tokens) plus a large share of the Family-C
mis-descriptions. **Rename caveat:** `MCP_TOOL_OVERRIDES.json` renames tools by writing `field: "name"`
records (e.g. `hudu_articles_search` → `hudu_search_articles`), so a rename is a *delete + add* on the
wire. This is a curation change, not a public-API change: the npm `exports` surface (`node-hudu/operations`,
`node-hudu/resources`, `node-hudu/types`, `node-hudu/errors`) is untouched, so additive-only still holds —
but any consumer that pinned `hudu_find_labels_by_labelable` in its own prompt/config breaks. Recommend
the 6 renames ship in the same emission as `hudu_search_knowledge` and are called out in `CHANGELOG.md`
with the old → new mapping. If that break is unacceptable, the fallback is description-only: lead every
Family-C description with *"Lists the records attached to one record (not an identity lookup)"*.

### Tiering (do this even without the new tool)

The manifest is ~245k tokens unshipped. A `core` tier of ~20 tools —
`search_knowledge`, `search_across_resources`, the 12 identity lookups, `get_article`, `get_asset`,
`get_company`, plus the 3 `getContext` tools — covers most agent questions; everything else is `extended`
and is loaded only when a task needs writes. The overrides file already carries a `tier` annotation
(`tier="helper"` appears on every projected tool), so this is a curation field, not new machinery.

---

## 2. The new tool

Mechanical name comes from `hudu_` + operation name (`scripts/project-mcp-tools.mjs`), so the operation is
`operations.searchKnowledge` and the override renames `hudu_operations_searchKnowledge` →
**`hudu_search_knowledge`**.

- **title** (override) — `Search Knowledge (ranked, fuzzy)`
- **description** (override; one line for the model, then the rules):

> Find the most relevant knowledge-base articles and assets for a fuzzy, imperfect query. Matches article
> BODY content, asset names, asset custom-field values and serials; tolerates typos and partial words; and
> returns each hit with a short plain-text snippet and a relevance score. This is the only search that reads
> article content — `hudu_search_across_resources` matches names and field values by exact substring only.
> Follow up with `hudu_get_article` or `hudu_get_asset` using the returned `resource` + `id`.
> Bounded: it scans at most 500 records / 4 pages per resource; when a cap stops the scan it returns
> `complete: false` and the counts it did examine. A hit means "found in what was scanned", never "this is
> everything". Never use it to enumerate or page: it ranks, it does not list.

- **inputSchema** (all fields honoured or absent — the checker's `inputSchema-conditional-field` rule
  fails a field the operation cannot honour):

```json
{
  "query":         {"type":"string","required":true,  "description":"Free text. Typos and partial words are tolerated. Minimum 3 characters unless exact_only is true."},
  "resources":     {"type":"array","items":{"type":"string","enum":["articles","assets"]},"required":false,"description":"Default [\"articles\",\"assets\"]. Articles are scanned first."},
  "limit":         {"type":"number","required":false,"description":"Ranked hits returned. Default 10, hard maximum 25 (each hit carries a snippet)."},
  "snippet_length":{"type":"number","required":false,"description":"Plain-text snippet characters per hit. Default 200, maximum 400, 0 returns no snippet."},
  "company_id":    {"type":"number","required":false,"description":"Scope to one company (applied as the vendor company_id filter and to the local scan)."},
  "updated_since": {"type":"string","required":false,"description":"ISO 8601. Only records updated at or after this time (mapped to the vendor updated_at filter)."},
  "min_score":     {"type":"number","required":false,"description":"0-100. Drops hits below the band. The response reports how many were dropped."},
  "exact_only":    {"type":"boolean","required":false,"description":"true disables fuzzy matching (vendor-style substring semantics, still ranked and snippeted)."}
}
```

- **Result shape** (new public type `SearchKnowledgeResult` / `SearchKnowledgeHit` in `src/types/`):

```json
{
  "query": "vpn tunnel down",
  "scope": ["articles","assets"],
  "hits": [
    {
      "resource": "articles",
      "id": 28,
      "label": "FortiGate VPN site-to-site troubleshooting",
      "company_id": 17,
      "company_name": "Fortinet Inc.",
      "updated_at": "2026-04-09T…Z",
      "url": "https://…/kba/…",
      "score": 92,
      "matched": { "field": "content", "term": "tunnel", "tokens_matched": 3, "tokens_total": 3 },
      "snippet": "…bring the IPsec tunnel back up: check phase-2 selectors, then…",
      "next_tool": "hudu_get_article"
    }
  ],
  "scanned":  { "articles": 8, "assets": 20 },
  "capped":   { "articles": false, "assets": false },
  "complete": true,
  "empty_reason": null,
  "below_min_score_dropped": 0
}
```

`next_tool` is deliberate: it removes one model decision for ~20 bytes. `complete` is the honesty flag —
`complete: true` only when **every** in-scope resource finished its scan without hitting a cap.

**Composition with existing tools** (works today on this tenant):

1. `hudu_search_knowledge({query:"vpn tunnel down"})` → hit `{resource:"articles", id:28, matched.field:"content"}`
2. `hudu_get_article({id:28})` → the full article body (28 is a pre-existing tenant article; the body-only
   token probe above used my own temporary article, since deleted).

**Token budget.** With `limit: 10`, `snippet_length: 200`, the payload is ≈5 KB (≈1.2k tokens): the
measured 8-snippet payload was 1,299 B vs 15,068 B for the same 8 records in full. Rules that keep it there:
`limit ≤ 25` (not 100 — a snippet-bearing hit is ~10× a compact row); snippets are HTML-stripped, whitespace-
collapsed and ellipsised; `content` is never returned whole by this tool, so `hudu_get_article` stays the
only way to burn context on a full body, and the model does it deliberately for one article.

---

## 3. How it plugs in (registry, projection, checker)

Pipeline: `capabilities.plan.json` → `npm run capabilities:build` → `capabilities.json` + `src/capabilities.ts`
→ `npm run mcp:project` → `MCP_TOOL_MANIFEST.md`, with `npm run capabilities:check` as the gate.

### 3.1 New plan row (`capabilities.plan.json`, in `operations`)

Every key is required on every row (`missing-key`); this mirrors the existing
`operations.searchAcrossResources` row, which is the closest analogue and already passes the gate:

```json
{
  "endpoint": null, "primitive": null, "specialOp": null, "vendorFilters": [], "search": null,
  "helper": "operations.searchKnowledge", "helperBasis": "composite",
  "helperRationale": "Removes an agent's own content scan: the vendor search filter never reads article bodies and never ranks, so without this helper every agent re-implements a paging loop, an HTML-stripped snippet extractor and a fuzzy scorer, and reads a capped scan as 'not in the knowledge base'.",
  "effect": "read", "flags": [], "dryRun": false,
  "metadata": {
    "purpose": "Find the most relevant knowledge-base articles and assets for a fuzzy query, with snippets and scores.",
    "usage": "Ranks article bodies, asset names, custom-field values and serials. Scans at most 500 records / 4 pages per resource; reports scanned/capped/complete. limit default 10, hard maximum 25.",
    "preferredWhen": "Preferred over operations.searchAcrossResources and the per-resource search helpers whenever the query is imperfect or the answer may be inside article content.",
    "related": ["operations.searchAcrossResources", "articles.get", "assets.get"]
  },
  "compact": "SearchKnowledgeHit",
  "resolution": { "basis": "client-scan", "maxScanRecords": 500, "maxScanPages": 4 },
  "staleCheck": null, "redaction": "none",
  "errors": ["CONFIG_ERROR", "NETWORK_ERROR", "RATE_LIMIT"],
  "tests": [
    {"id":"operations.searchKnowledge.content","file":"test/operations.test.ts","title":"matches an article by a body-only token"},
    {"id":"operations.searchKnowledge.fuzzy","file":"test/operations.test.ts","title":"matches a misspelled query token within the documented edit distance"},
    {"id":"operations.searchKnowledge.rank","file":"test/operations.test.ts","title":"orders hits by score and breaks ties on updated_at then id"},
    {"id":"operations.searchKnowledge.snippet","file":"test/operations.test.ts","title":"returns a plain-text snippet with markup stripped and length capped"},
    {"id":"operations.searchKnowledge.caps","file":"test/operations.test.ts","title":"reports scanned/capped/complete and never claims a truncated scan is complete"},
    {"id":"operations.searchKnowledge.empty","file":"test/operations.test.ts","title":"returns no hits with HTTP 200 semantics and empty_reason no_match"}
  ],
  "group": "operations", "status": "planned"
}
```

Also needed: an `articles`/`assets`-side decision — I recommend **no new per-resource rows**. The content
scan belongs in the composite helper, which already has a home for cross-resource fan-out and cap reporting.

### 3.2 Rules this feature will trip, and how to stay green

| Checker rule | What it demands here |
|---|---|
| `helper-rationale`, `helper-tests`, `helper-usage` | `helperRationale`, a non-empty `tests[]`, and `metadata.usage` — all present above |
| `compact-shape-unknown` | `SearchKnowledgeHit` must be declared in `src/types/**` (not inline) |
| `helper-compact-drops` | the registry record's `outputSchema` needs a real `drops` array and must not set `dropsUnresolved`; declare what the compact hit drops from the full record |
| `resolution-caps` | a `client-scan` basis needs **both** `maxScanRecords` and `maxScanPages` |
| `errors-vocabulary` | SCREAMING_SNAKE only, `CONFIG_ERROR` on every row; do not invent `SCAN_TRUNCATED` — the partial-scan signal is a *field* (`complete`/`capped`), not an error, so `RESOLUTION_TRUNCATED` should not be listed unless the helper really throws it |
| `inputSchema-conditional-field` | every advertised field must be honouring (`expand` would fail: this tool deliberately has no `expand`) |
| `prose-dangling` | `purpose`/`usage`/`preferredWhen` must not name a method the client lacks — `operations.searchAcrossResources`, `articles.get`, `assets.get` all exist; **do not copy** `assets.listAllAcrossCompanies` from `hudu_find_assets_by_serial` |
| `related-dangling` | every `related` entry needs a registry record |
| `preferredWhen` | a row of a resource that has a helper needs `preferredWhen` — present |
| `coverage-registry` / `registry-orphan` | a row at `implemented`/`tested` needs a matching record in `src/capabilities.ts`, and vice versa — build both |
| `test-title`, `test-row` | at `status: "tested"`, each `tests[]` title must exist **verbatim** in the named file |
| `emission-planhash` | editing the plan changes `planHash`; `capabilities.json` is stale until `npm run capabilities:build` |
| `manifest-planhash` | the manifest must carry the new `planHash` and the new registry record count — `npm run mcp:project` after the build, never hand-edit |
| `ship-status`, `batch-status` | a `--ship` check passes only at `tested`, so the row must be driven `planned → implemented → tested`, not left planned |

### 3.3 Curation and example artefacts

- `MCP_TOOL_OVERRIDES.json`: 3 new records for the new tool (`field: "name"` → `hudu_search_knowledge`,
  `field: "title"`, `field: "description"`) with reasons in the existing house style. The projection takes
  `description` from the registry `purpose` **verbatim** and never re-derives it, so the model-facing
  description must be written as an override (or as `purpose` — but `purpose` is also the SDK doc line).
- 8 new `exclude: true` override records for the retired `hudu_search_<resource>` tools, each with a reason;
  the manifest will then list them under "Excluded by curation", which is the documented, auditable way to
  shrink the surface.
- `examples/mcp-server.ts`: **this is the likely break.** `npm run mcp:project -- --check-example` fails on
  "an unknown tool name, an unbounded read, a mutating tool with no dry-run affordance, or a description
  that is not the curated one", so the example must be updated in the same change as the projection, or the
  gate fails. Any retired tool still named in the example fails the same check.
- `MCP_TOOL_MANIFEST.md` is machine-generated ("Do not hand-edit") — regenerate, never patch.
- Verification sequence after implementation:
  `npm run typecheck && npm test && npm run capabilities:check -- --group operations && npm run capabilities:build && npm run capabilities:check && npm run mcp:project && npm run mcp:project -- --check-example`
  (**UNVERIFIED** — no implementation exists yet, so this exact sequence has not been run.)

### 3.4 The zero-dependency constraint

Everything new is in-repo JS: tokenisation, a bounded Damerau-Levenshtein (early exit at the edit cap) and a
trigram overlap for long-token near-misses, HTML stripping via a small regex + entity map, and a scoring
table with documented weights. No scoring library, no vector store, no API call to an embedding provider.
`node >= 18`, dual ESM+CJS: everything is plain ESM TypeScript compiled by the existing `tsup` config, so
both outputs come free; avoid any node API newer than 18.

---

## 4. Agent ergonomics, failure modes, risks

**Nothing found.** Return `hits: []`, `complete` and `scanned` — **do not throw NOT_FOUND**. A search is a
query, not a resolution: an absent record and an absent match are different facts, and `NOT_FOUND` on a
search teaches a model that the *tenant* lacks the data. The vendor already behaves this way — every empty
search above returned `200 {"articles":[]}` — so there is nothing to work around, only a rule to keep.
Set `empty_reason: "no_match"` and `complete` truthfully, because "no match in 8 records" and "no match in
the first 500 records of a 40,000-record tenant" demand different next moves from the agent.

**Ambiguous query.** Return the ranked list and never guess a single answer; if `resources` spans articles
and assets, hits from both appear, each carrying `resource`. Add `tokens_unmatched: ["..."]` for query
tokens that matched nothing anywhere, so the model can drop a bad word and re-query instead of reporting no
results.

**`min_score` hid things.** Never let a threshold look like absence: report `below_min_score_dropped: n`.
Same rule for the vendor pass and the local pass — if the local scan was skipped (cap reached) say so in
`capped`, rather than returning a short list that reads complete.

**Huge tenant.** The scan is capped (500 records / 4 pages, the repo's existing resolution caps) and
page-sized reads only. `complete: false` plus `scanned` is the honest answer. The real risk is the opposite
of the usual one: an agent trusts a *partial* result as complete and reports "not documented" to a human.
Mitigations, strongest first: (1) `complete` is a required field, never absent; (2) the description's last
sentence states the cap and its meaning; (3) `articles` is scanned before `assets`, so a capped run still
covers the resource the user cares about first; (4) do **not** let a tool surface set `complete` from "no
more pages came back" — `hasMore: false` is the only evidence of completeness, the same rule `boundedScan`
already applies to `scanTruncated`.

**Follow-up must be obvious.** `next_tool` + `resource` + `id` in every hit; `url` for the human; `match.term`
so the model can see *why* it matched (a hit on a fuzzy term is weaker evidence than a hit on the exact
term). Snippet is plain text — leaving HTML in the snippet burns tokens and pollutes the model's read of it.

**Scores invite over-trust.** Make `score` an integer 0–100 with a **documented, stable** band and publish
it in the description (e.g. `>= 90` name/serial field exact, `70-89` token-complete name or content match,
`50-69` partial token overlap, `< 50` fuzzy-only). A model will treat the number as a probability; a band
is honest about what the number is. Score ties break on `updated_at` desc, then `id` asc, so the same query
gives the same order twice.

**False positives from fuzzy short tokens.** A 3-character query with edit distance 1 matches almost
anything. Rule: fuzzy edits only for tokens of length ≥ 5 (distance ≤ 2) and ≥ 4 (distance ≤ 1); below that,
exact/prefix only; `exact_only: true` disables fuzzy entirely.

**Credential and secret surface.** `asset_passwords` and `websites` are deliberately **out of scope** for
`hudu_search_knowledge`: a snippet built from a password record is a secret placed into model context, and a
relevance score over secrets is a leak channel. Their search coverage stays with
`hudu_search_across_resources` (name-only, compact rows, no snippet). This is a design boundary, not an
implementation detail — do not "add resources later" without re-deciding it.

**One resource failing must not fail the query.** `operations.searchAcrossResources` has no per-resource
try/catch (`SEARCH_HELPERS` + `boundedMap`), so a single 5xx or 429 rejects the whole call and the agent
learns nothing. The new helper isolates each resource and reports it (`"failed": {"assets": "RATE_LIMIT"}`),
and the same fix belongs in `searchAcrossResources`. Supporting live evidence: `GET /ip_addresses`,
`/vlans`, `/networks` with `page_size=100` all return **HTTP 400** — a resource like that inside a fan-out
would today destroy the entire search.

**Vendor gotcha seen while probing (record, do not fix here):** after `DELETE /articles/31` returned `204`
and the article vanished from `GET /articles`, `GET /articles/31` still returned **`200` with body `null`**.
Any new tool must not treat a `200 null` body as a record.

---

## 5. What I would NOT build, and why

1. **No embeddings / vector search.** Zero runtime dependencies is a hard constraint and Hudu exposes no
   vector index; an embedding provider would add a dependency, a cost, a data-egress path and a second
   source of truth. Trigram + bounded edit-distance scoring is the whole budget.
2. **No persistent local index or cache.** A cache of a client's KB inside an MCP server is stale the moment
   a human edits an article, is a data-at-rest liability, and cannot be invalidated without the vendor's
   `updated_at` sweep anyway — which is the scan we already do.
3. **No paging of search results.** A ranked result set is not a collection. If an agent needs *all*
   matches, the existing list + `search` filter is the honest tool; a "search page 2" invites the model to
   treat a bounded scan as a dataset.
4. **No `search_knowledge` writes, no "related articles" recommendations, no auto-summarisation.** Each is a
   separate capability with its own contract; nothing in the probe work justifies them.
5. **No retiring of the 12 identity lookups** (Family B). Live evidence: `primary_serial` is not searchable
   and field labels are not searchable, so search cannot replace exact-key resolution.
6. **No raising of `limit` to 100 for the new tool.** 25 is the cap because a snippet-bearing hit is ~10× a
   compact row; the compact path for bulk reading already exists.
7. **No new per-resource `searchContent` methods** on `articles`/`assets`. One composite ranked helper
   keeps the fan-out, the caps and the "what was scanned" reporting in one place; five per-resource variants
   would multiply the tool surface this proposal exists to shrink.

---

## 6. Evidence log

Commands and outputs are quoted verbatim in §0 and §3. Summary of what was executed:

- Live vendor probes (Python `requests`, `x-api-key` auth): `README`-level GETs on `/api_info`, `/articles`,
  `/assets`, `/companies`, `/asset_layouts`, `/companies/3/assets` (POST), `/articles/31` (DELETE + GET).
- Live SDK probes (`node /tmp/probe1.mjs`, `node /tmp/probe2.mjs`, `node` one-liners against
  `dist/index.js`): `articles.create/search`, `assets.create(3, …)`, `assets.search`, `companies.list`.
- Local reads: `src/operations/operations.ts`, `src/operations/types.ts`, `src/resources/base.ts`
  (`boundedScan`, `requireResolved`), `src/resources/articles.ts`, `src/resources/assets.ts`,
  `src/types/asset.ts`, `api-docs.json` (82 paths, `/articles` + `/assets` parameter docs),
  `MCP_TOOL_MANIFEST.md` (all 27 search/find tool sections), `MCP_TOOL_OVERRIDES.json`,
  `capabilities.plan.json` (row keys + rows 20/21/22/223), `scripts/check-capabilities.mjs` (48 rule ids),
  `scripts/project-mcp-tools.mjs` (projection + `--check-example` rules), `package.json` scripts.

**Sandbox hygiene.** Two records were created and both were deleted; the tenant was never modified
otherwise. Final inventory:

- `DELETE /articles/31` → `204` (probe article "ZZ probe Zephyrzzq7brmp runbook")
- `DELETE /companies/3/assets/363` → `204` (probe asset "ZZ probe Wombatzzq7brmp laptop")
- leftovers matching the probe nonce `zzq7brmp` across articles + assets + companies: **0**
- remaining articles: 16 `FortiOS Recommended Releases`, 17 `Test article`,
  18/19 `AUPOST-WS01{2,3} - Workstation Summary`, 28 `FortiGate VPN site-to-site troubleshooting`,
  29 `New starter onboarding runbook (Microsoft 365)`, 30 `Printer toner replacement and error codes`
  (7 — all pre-existing; articles 25 and 27, which existed at the start of the session, were removed by
  another agent working in the same shared tenant, not by me)
- remaining assets: 20 pre-existing `AUPOST-WS001`…`WS020` (plus my probe asset, deleted)
- companies: 23, all pre-existing.

No API key was written into any file in the repo.

**Steering facts re-confirmed live in this session:** body-content miss; article list carrying `content`;
asset custom-field value hit + `primary_serial` miss; contiguous-substring/typo behaviour; the
`search`-ignored-unfiltered-page hazard on `activity_logs` (100 rows for a garbage query), `expirations`,
`lists`, `folders`; and that all 8 in-scope resources honour `search` (garbage → 0 rows).

**UNVERIFIED items:** the scoring weights, edit-distance thresholds and snippet extraction exist only in this
document — no implementation, so their behaviour, the `capabilities:check` pass above the new row, and the
`--check-example` outcome are all unrun. The rename of the 6 Family-C tools has not been validated against
`project-mcp-tools.mjs` (it is a rename-via-overrides pattern the file already uses 644 times, so the
mechanism is attested, but not for these specific tool names).
