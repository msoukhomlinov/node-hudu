# One self-describing search tool: `hudu_search` (search | help | resources)

Status: **DESIGN ONLY**. No file under `src/`, `test/` or `scripts/` was changed; nothing committed.
Scratch: Python cells in the REPL and `/tmp` only. This document is `.run/design/search/single-search-tool.md`.
Inputs (built on, not re-derived): `PROPOSAL.md` (§11.2 asks for exactly this), `engine-design.md` (§3 meta
vocabulary, §4.1 snippet honesty, §5 byte budget), `capability-inventory.md`, `mcp-surface.md` (§1 audit, §2
first tool draft, §3 gate list).
Everything byte-counted below was measured in this session against the repo's own artefacts
(`MCP_TOOL_MANIFEST.md`, `capabilities.plan.json`, `capabilities.json`, `MCP_TOOL_OVERRIDES.json`,
`scripts/check-capabilities.mjs`, `scripts/generate-capabilities.mjs`, `examples/mcp-server.ts`). Live sandbox
probes were NOT re-run for this document (the ground truth was taken as given); every claim that depends on a
live call is marked **UNVERIFIED-HERE** and every unbuilt behaviour is marked **UNVERIFIED**.

---

## 1. The tool

### 1.1 Identity

| | |
|---|---|
| MCP tool name | **`hudu_search`** (projected as `hudu_operations_searchKnowledge`, renamed by an override) |
| Title (override) | `Search Hudu (search \| help \| resources)` |
| Backing operation | `operations.searchKnowledge` (one new helper row, `mode` on its input bag) |
| Effect | `read`; `readOnlyHint: true`; no dry-run (no write path); no vendor request in the two meta modes |
| Audience | any MCP client; the SDK's helper tier is unchanged and additive (`operations.searchAcrossResources`, `articles.search`, the 12 `find*` helpers all stay callable) |

**Why `hudu_search` and not `hudu_search_knowledge`** (the name approved in `PROPOSAL.md` §2): two of the three
modes are not knowledge-base reads at all - `help` returns prose about the tool and `resources` returns the
searchable-resource table. A tool literally named `search_knowledge` that answers "what can you search?" and
"how do I use you?" is mis-named for 2/3 of its contract, and the name is the only thing a model sees before
it reads the description. `hudu_search` is the shortest name that is true for all three modes, and it is the
name a model will reach for when it wants search (discoverability, §6.1). The SDK operation keeps the approved
name `operations.searchKnowledge`, so the additive public surface promised in the proposal is unchanged.

### 1.2 The description (verbatim, LLM-facing, projected through `MCP_TOOL_OVERRIDES.json`)

Measured: **2,085 bytes**. This is the only prose a client pays for on every turn.

```text
Search Hudu. One entry point with three modes: mode="search" (default) runs the query; mode="help" returns how to use this tool; mode="resources" returns what is searchable and what each vendor text filter really covers. "search" needs query; "help" and "resources" need nothing else.
mode="search": ranked, fuzzy search over article TITLE and BODY content, asset names, asset custom-field VALUES and asset identifiers (primary_serial/model/mail), plus company/user/group/website names. Tolerates typos, partial words and reordered words (the vendor's own search does none of these, and never reads article bodies). Every hit carries resource, id, a plain-text snippet, a 0-100 score band and match.fields - so you can see why it matched. Full bodies are never returned: fetch the one you need with hudu_get_article / hudu_get_asset (or the hudu_get_* for that resource).
Bounds and honesty: limit default 8, max 25; snippetChars default 200, max 400 (0 = no snippet); scan cap 500 records / 4 pages per resource. When any bound bites, complete is false and truncation.reason names it. An empty hit list is only a complete answer when degraded is null - read degraded first: it says when article bodies were not searched (body-not-indexed) or the index was cold (vendor-only), and what to do about it. degraded is per-response, never omit-checked: read it before reporting "nothing found".
mode="help" returns defaults, limits, score bands, degradation and empty-result semantics, and the follow-up pattern; optional topic picks one section. mode="resources" returns the searchable-resource table (exact vendor filter fields per resource; every other resource ignores ?search= silently and returns an unfiltered page, so it is not searchable).
Not for identity lookup: to resolve one record by exact key (serial, slug, domain, email) use hudu_find_* or hudu_get_*, and to page or enumerate use the resource's hudu_list_* tool. Do not use this tool to enumerate.
A field the selected mode cannot honour is a CONFIG_ERROR naming the fields that mode does honour - never silently ignored.
```

Deliberate properties, in the order they appear:

1. **The first clause names all three modes** and which one runs without arguments. A model that reads only
   the first line still knows `help` exists - the mitigation for "the model never realises help exists".
2. **The hot path is stated as the default**, so adding a mode does not change the common call.
3. **`degraded` is called out as a field to read, with the two values that matter** (`body-not-indexed`,
   `vendor-only`). This is the honesty contract of `engine-design.md` §3, in the always-on text, because a
   model that never reads `degraded` will report "not documented" for content that exists.
4. **"Not for identity lookup"** stops the classic misuse (`hudu_find_assets_by_serial` exists precisely
   because `?search=` never sees `primary_serial`).
5. **The last line kills mode ambiguity in one sentence**: a field the mode cannot honour is a config error,
   never a silent ignore.

### 1.3 The input schema

`mode` is the only new axis. Every other field is an existing search option, renamed to the SDK's camelCase
(the proposal's §7 recommendation).

```json
{
 "mode": {
  "name": "mode",
  "type": "string",
  "enum": [
   "search",
   "help",
   "resources"
  ],
  "required": false,
  "description": "Which mode to run. Default \"search\": the query runs, nothing else is needed. \"help\" returns how to use this tool (defaults, limits, score bands, degradation semantics) - no query. \"resources\" returns what is searchable and the exact vendor filter fields per resource - no query. A field the selected mode cannot honour is CONFIG_ERROR naming the fields it does honour, never silently ignored."
 },
 "query": {
  "name": "query",
  "type": "string",
  "required": false,
  "description": "Free text, 3+ chars (1+ with exact_only). Required for mode=\"search\". Typos, partial words and reordered words are tolerated; article BODY content is searched. Omitting it with mode=\"search\" is CONFIG_ERROR (it does NOT fall back to help). Ignored-and-rejected if mode is \"help\" or \"resources\"."
 },
 "resources": {
  "name": "resources",
  "type": "array",
  "items": {
   "type": "string",
   "enum": [
    "articles",
    "assets",
    "companies",
    "users",
    "groups",
    "websites",
    "asset_passwords",
    "password_folders"
   ]
  },
  "required": false,
  "description": "Which resources to search. Default [\"articles\",\"assets\"] (articles first). A name outside this enum is CONFIG_ERROR. asset_passwords/password_folders are returned redacted with snippetChars forced to 0."
 },
 "topic": {
  "name": "topic",
  "type": "string",
  "enum": [
   "core",
   "all",
   "query",
   "limits",
   "scoring",
   "degradation",
   "results",
   "followup"
  ],
  "required": false,
  "description": "mode=\"help\" only: which section to return. Default \"core\" (modes, limits, degradation, results, follow-up); \"all\" adds query syntax and the full scoring table; a single name returns just that section. mode=\"resources\" ignores it and is rejected if passed."
 },
 "limit": {
  "name": "limit",
  "type": "number",
  "required": false,
  "description": "mode=\"search\" only. Ranked hits returned: 1-25, default 8. A larger value is CONFIG_ERROR, never clamped. Each hit carries a snippet, so this is not a page size."
 },
 "snippetChars": {
  "name": "snippetChars",
  "type": "number",
  "required": false,
  "description": "mode=\"search\" only. Plain-text snippet characters per hit: 0-400, default 200, 0 = no snippet. Snippets are verbatim slices of the HTML-stripped record text."
 },
 "company_id": {
  "name": "company_id",
  "type": "number",
  "required": false,
  "description": "mode=\"search\" only. Scope the scan to one company (vendor company_id filter where the resource documents it, and the local scan)."
 },
 "updated_since": {
  "name": "updated_since",
  "type": "string",
  "required": false,
  "description": "mode=\"search\" only. ISO 8601. Only records updated at or after this instant (vendor updated_at range filter)."
 },
 "min_score": {
  "name": "min_score",
  "type": "number",
  "required": false,
  "description": "mode=\"search\" only. 0-100 band floor. Hits below it are dropped and the count dropped is reported in meta, so a threshold never looks like absence."
 },
 "exact_only": {
  "name": "exact_only",
  "type": "boolean",
  "required": false,
  "description": "mode=\"search\" only. true disables fuzzy matching (vendor-style exact substring), still ranked and snippeted. Default false."
 }
}
```

Notes that matter for the build:

- **The enum must be an inline string-literal union in the TS type.** `scripts/generate-capabilities.mjs`
  turns `Array<'a'|'b'>` into `{"type":"array","items":{"type":"string","enum":[...]}}`, but a *named*
  alias (`SearchableResource[]`) becomes `{"type":"array","items":{"type":"object"}}` - measured in
  `capabilities.json`: `operations.searchAcrossResources.opts.resources` today ships
  `{"type":"array","items":{"type":"object"}}`, i.e. **the manifest tells the model nothing about the eight
  legal names**. Declare the union inline (or force it through an `inputSchema.opts` override) so the
  contract is in the schema, not only in prose. Same for `mode` and `topic`.
- `query` is `required: false` at the schema level on purpose. It is required *conditionally* (only in search
  mode) and a schema-level `required: true` would make the meta modes un-invokable on a strict client. The
  condition is enforced by the operation and stated in both descriptions. This is the one honest place where
  the schema cannot express the contract, and it is documented rather than left implicit.

### 1.4 How the mode is selected, and why

**Decision: an explicit `mode` enum, optional, defaulting to `"search"`. Not overloaded optional parameters.**

Rejected alternative - "omit `query` to get help" (the cheapest possible schema): it is exactly the failure
mode this repo fights. `mcp-surface.md` §1 found the whole feature's most important fact is an *omission* (the
vendor search never reads bodies), and a model that omits or mistypes `query` would silently receive prose
instead of an error, then either report "no results" or burn a turn. A tool whose behaviour depends on which
field you leave out is ambiguous by construction, and the schema cannot express the rule for the model to read.

Rejected alternative - a second tool `hudu_search_help`: unambiguous, but it is the 2-tool design this
consolidation exists to avoid, and it puts the tool count back up. It remains the **fallback** if the enum
proves unworkable in a real client (§6.6).

**Rules that make mode confusion impossible** (each is checkable and each is in the contract):

| # | Rule | Effect |
|---|---|---|
| R1 | `mode` is optional with default `"search"` | the schemas shape is static - there is no "which field is required" puzzle; the hot path pays one field |
| R2 | `query` missing/empty **with** `mode="search"` (or omitted) -> `CONFIG_ERROR` naming `mode:"help"` as the fix | an accidental empty call can never silently return prose |
| R3 | a field the selected mode cannot honour -> `CONFIG_ERROR` listing that mode's honoured fields | no parameter is ever silently ignored; the tool cannot do something other than what the call says |
| R4 | each mode returns a **distinct top-level shape keyed by `mode`**: `{mode:"search",hits,meta}` / `{mode:"help",help}` / `{mode:"resources",resources}` | a response cannot be misread as another mode's; `meta.mode` echoes the call so the transcript is self-describing for the next model |
| R5 | the two meta modes perform **no vendor request and no index build** | `help`/`resources` can never be expensive, can never be an accidental search, and can never mutate index state |
| R6 | `mode` values in the response are the same strings as the schema enum | no synonym drift (`"docs"`, `"usage"`, `"capabilities"` are all rejected with a message naming the three legal values) |

R2/R3 are the load-bearing pair: with them, the *only* way to reach a mode is to ask for it by name.

### 1.5 What each mode returns

```jsonc
// mode:"search"  (default) - the engine's result shape from engine-design.md 3, unchanged
{ "mode": "search", "query": "vpn tunnel down", "hits": [ { "resource": "articles", "id": 28,
    "title": "FortiGate VPN site-to-site troubleshooting", "score": 92, "relevance": 1.0,
    "scoreScope": "cross-resource", "match": { "fields": ["title","body"], "terms": ["vpn","tunnel"],
      "coverage": 1.0, "fuzzy": false },
    "snippet": { "text": "...bring the IPsec tunnel back up: check phase-2 selectors, then...",
      "spans": [[37,43]], "truncated": true }, "fetch": "hudu_get_article", "url": "https://.../kba/..." } ],
  "meta": { "mode": "search", "scanned": {...}, "complete": false, "truncation": { "reason": "result-limit" },
    "degraded": null, "scoreScope": "cross-resource", "index": { "state": "warm", "staleness": "fresh" },
    "errors": [], "tokens_unmatched": [], "below_min_score_dropped": 0, "redaction": "none", "bytes": 4211 } }

// mode:"help"  - static, generated, no vendor call
{ "mode": "help", "topic": "core", "help": { "text": "<the payload in 2.2>", "sections": ["modes","limits",
  "degradation","results","followup"], "bytes": 3468, "toolVersion": "0.4.0", "indexState": "cold" } }

// mode:"resources" - derived from the registry, no vendor call
{ "mode": "resources", "resources": { "searchable": [ { "resource": "articles",
    "textFilter": "name (TITLE) only - not the body, not the slug",
    "otherFilters": ["company_id","draft","enable_sharing","name","slug","updated_at"],
    "redaction": "none", "snippetAllowed": true }, ...8 rows ],
  "notSearchable": [ { "resource": "activity_logs", "filters": ["action_message", ...],
    "reason": "no search vendor filter - ?search= is ignored and page 1 comes back unfiltered" } ],
  "table": "<the payload in 2.3>", "derivedFrom": "capabilities.plan.json:search", "bytes": 3417 } }
```

`mode:"resources"` is generated from the same `searchableResources` set the engine filters on (the plan rows
where `search === "search"`). It is not a hand-written string: a hand-written table drifts from the registry,
and a drifted table in an LLM's context is a wrong answer generator. That is why §5 adds a checker rule for it.

### 1.6 SDK shape (the programmatic tier)

One operation, one input bag, a discriminated union on `mode`:

```ts
export type SearchKnowledgeInput = {
  mode?: 'search' | 'help' | 'resources';   // inline union - see 1.3
  query?: string;                            // required iff mode === 'search' (default mode)
  resources?: Array<'articles'|'assets'|'companies'|'users'|'groups'|'websites'|'asset_passwords'|'password_folders'>;
  topic?: 'core'|'all'|'query'|'limits'|'scoring'|'degradation'|'results'|'followup';
  limit?: number; snippetChars?: number; company_id?: number; updated_since?: string;
  min_score?: number; exact_only?: boolean;
};
export type SearchKnowledgeResult = SearchKnowledgeHits | SearchKnowledgeHelp | SearchableResourcesResult;
```

Why one operation and not three: the projection rule is one tool per distinct *outcome*, and the three modes
share one entry point by design; splitting the registry row would either project three tools (defeating the
consolidation) or need two `exclude: true` overrides plus a new rule to keep them in step, for no test or type
benefit (the payloads are pure functions of the registry table). The god-tool risk is answered in the
implementation, not the signature: three internal modules (`search/rank.ts`, `search/help.ts`,
`search/resources.ts`) and a dispatcher of a few lines, so `help` and `resources` are unit-testable with no
client and no network, and each mode's `tests[]` entry asserts its own shape (**UNVERIFIED** - not built).

---

## 2. The payloads (worked, measured)

### 2.1 Sizes

| Payload | Measured bytes | ≈ tokens @4 B/tok |
|---|---|---|
| `mode:"help"`, `topic:"core"` (default) | **3,468** | 867 |
| `mode:"help"`, `topic:"all"` | 5,114 | 1,279 |
| one help section (`limits` / `degradation` / `results` / `followup` / `scoring` / `query`) | 395-1,098 | 99-275 |
| `mode:"resources"` | **3,417** | 854 |

A single help fetch (3.5 kB) is therefore about a quarter of what the 27 tool descriptions cost on *every turn*
(13,940 B), and the topic selector makes the "one fact I need" case ~0.4 kB. The 4 B/token convention is the repo's own: the
manifest reports itself as 980,476 B / ~245k tokens.

### 2.2 `mode:"help"`, `topic:"core"` - verbatim payload

```text
HUDU SEARCH - how to use it (mode="search" is the default)

MODES
  mode="search"     run the query. Needs query.
  mode="help"       this text. Optional topic: one of
                    query|limits|scoring|degradation|results|followup (default: all).
  mode="resources"  what is searchable, and the exact vendor filter fields per resource.
  mode is echoed in the response as meta.mode. No other field is required.
  A field the chosen mode cannot honour is CONFIG_ERROR, never ignored.

LIMITS (topic: limits)
  limit            8 default, 25 max, min 1. A ranked result set is not a pageable collection.
  snippetChars     200 default, 400 max, 0 = no snippet.
  scan             500 records / 4 pages per resource (client config can lower, never raise).
  maxResponseBytes 8192: the hit list stops rather than exceed it.
  min_score        0-100 band filter; the count dropped is reported, so a threshold never
                   looks like absence.
  Every bound that bites sets complete:false and truncation:{reason, ...} with
  reason in result-limit|response-bytes|candidate-cap|index-partial|fetch-budget|body-truncated.

SCORING (topic: scoring)
  score is 0-100 and is a RANK, not a probability. 90+ exact title/identifier hit; 70-89 every
  term matched; 50-69 partial coverage; <50 fuzzy-only. relevance (1.0 = best in THIS response)
  is the number to show a human. scoreScope:"per-resource" means do not compare scores across
  resources; "cross-resource" means you may. Ties break updated_at desc, then (resource,id) asc.

  vendor-only       no index yet (cold client). Titles, names, field values and identifiers
                    were searched; article BODIES were NOT. Body-scope-only terms are
                    reported in truncation. Call again in a moment to use the warmed index.
  body-not-indexed  bodies exist but are not indexed (indexArticles:false, or every article
                    body exceeded maxDocBytes). A no-match answer here means "not in the
                    searched fields", NOT "not in the knowledge base".
  no-index          the index could not be built (permission/endpoint). Vendor-only results.
  degraded.advice always says what to do next. index:{state,builtAt,ageMs,staleness} reports
  index health; staleness:"stale" means the TTL passed and a refresh runs in the background.
  Per-resource failures are isolated: a resource that errored appears in errors[]
  ({resource,code,message}) and never voids the other resources' hits.

RESULTS (topic: results)
  Hits are ordered by score. Each hit: {resource,id,title,score,relevance,scoreScope,
  match:{fields,terms,coverage,fuzzy},snippet:{text,spans,truncated},fetch,url}.
  match.fields is where it matched: title|slug|body|custom_field|ident. A fuzzy match is
  weaker evidence than an exact one - say so when you report it.
  snippet.text is a verbatim slice of the record's EXTRACTED plain text (HTML stripped,
  entities decoded), never a summary, never markup. spans index into snippet.text.
  AN EMPTY HIT LIST: hits=[] with complete=true and degraded=null means "no match in what was
  scanned". Any other combination is a partial or body-blind answer and must be reported as
  such. Never report "no results" while degraded is non-null or complete is false.
  tokens_unmatched lists query terms that matched nothing - drop them and re-query instead of
  reporting failure.

FOLLOW-UP (topic: followup)
  1. hudu_search(mode:"search", query:"vpn tunnel down") -> hit {resource:"articles",id:28}
  2. hudu_get_article({id:28}) for the full body (the only way to spend context on a body).
  Identity lookup by exact key is hudu_find_* / hudu_get_* (serial, slug, domain, email);
  paging/enumeration is the resource's hudu_list_* tool. This tool ranks; it does not list.

WHAT THIS TOOL IS NOT
  Not a full-text export, not paging, not a write path, and not a place to read secrets:
  asset_passwords/password_folders hits are returned redacted with snippetChars forced to 0
  (meta.redaction:"credentials") - the record's secrets are never placed in context.
```

`topic:"all"` additionally returns the `QUERY` and full `SCORING` sections (**UNVERIFIED** - both are
specified in `engine-design.md` §2/§3, not implemented).

### 2.3 `mode:"resources"` - verbatim payload (generated from the registry)

```text
HUDU SEARCH - what is searchable (mode="resources")

SEARCHABLE (the vendor accepts ?search= and these rows honour it)
  resource             vendor text filter covers                  other exact filters on the same list call
  articles             name (TITLE). NOT the body, NOT the slug   company_id, draft, enable_sharing, name, slug, updated_at
  assets               name, custom-field VALUES. NOT field       archived, asset_layout_id, company_id, id, name,
                       labels, NOT primary_serial/model/mail      primary_serial, slug, updated_at
  companies            name                                     city, id_in_integration, id_number, name,
                                                                  phone_number, slug, state, updated_at, website
  users                first/last name. NOT the email             archived, email, first_name, last_name,
                                                                  portal_member_company_id, security_level
  groups               name                                      default, name
  websites             name                                      name, slug, updated_at
  asset_passwords      name (REDACTED: snippetChars forced to 0) archived, company_id, name, slug, updated_at
  password_folders     name (REDACTED: snippetChars forced to 0) company_id, name

NOT SEARCHABLE - ?search= is SILENTLY IGNORED on these and returns an UNFILTERED page.
  Never treat their rows as matches. Their rows are reached with exact filters only:
  activity_logs (action_message, resource_id, resource_type, start_date, user_email, user_id)
  expirations (archived, company_id, expiration_type, resource_id, resource_type)
  flags (flag_type_id, flagable_id, flagable_type, description, created_at, updated_at)
  labels (label_type_id, labelable_id, labelable_type, user_id, created_at, updated_at)
  label_types, lists (name, query), matchers (sync_id, integration_id, identifier, matched),
  magic_dash (company_id, title), networks (address, company_id, name, network_type, slug, ...),
  vlans (vlan_id, vlan_zone_id, company_id, name, ...), vlan_zones, ip_addresses (address, fqdn,
  status, network_id, asset_id), rack_storages, rack_storage_items, procedures (name, slug, type, ...),
  procedure_tasks, relations (fromable/toable), folders (name, company_id, folder_type), photos,
  asset_layouts (name, slug, active), cards, api_info, uploads, exports.

WHY THIS LIST IS EXACT
  It is generated from the capability registry: a resource appears under SEARCHABLE only when its
  list row declares a `search` vendor filter (capabilities.plan.json -> vendorFilters). A resource
  that does not declare it does not filter - the vendor returns page 1 unchanged, and presenting
  those rows as hits would be a false match for every query. This tool never does that: a resource
  without a declared text filter is rejected with CONFIG_ERROR.
  UNVERIFIED-THIS-SESSION note: the 8 SEARCHABLE rows and the 3 named non-searchable rows
  (activity_logs, expirations, folders) were confirmed live on Hudu 2.45.1; the remaining
  NOT-SEARCHABLE rows are taken from the registry (they declare no `search` filter), not re-probed.

INDEX (read-only)
  The body index is in-memory, per client+tenant, TTL 10 min. This mode never builds it and makes
  no vendor request; mode="search" warms it lazily. Report is in meta.index on a search response.
```

Every `SEARCHABLE` row and every filter name above was read out of `capabilities.plan.json` in this session
(the 8 rows where `search === "search"`, with their `vendorFilters` lists quoted exactly). The three rows
called out as confirmed-ignored were also probed live in the prior session
(`activity_logs`, `expirations`, `folders` each returned an unfiltered page for a garbage query per
`mcp-surface.md` §0b hazard 5). The remaining rows in `NOT SEARCHABLE` are registry-derived, not re-probed:
**UNVERIFIED-HERE**.

### 2.4 A worked search call

```text
hudu_search({"query": "vpn tunnel down"})
```
-> hits: `{resource:"articles", id:28, title:"FortiGate VPN site-to-site troubleshooting", match.fields:
["title","body"], fetch:"hudu_get_article", snippet:"...bring the IPsec tunnel back up: check phase-2
selectors, then..."}`, `meta.degraded: null`, `meta.complete: true`.
Follow-up is one deliberate `hudu_get_article({id:28})` - the only way a body enters context.
An unbuilt `hudu_search({"query":"vpn tunel down"})` returns the same top hit with
`match.fuzzy:true` and a lower band (**UNVERIFIED**: the scorer is not implemented).

---

## 3. Token math (measured)

### 3.1 Method

The manifest is one markdown section per tool (`### hudu_<tool>`), so every number below is a real byte count
from `MCP_TOOL_MANIFEST.md` for the 27 search/find tools (59,238 B of sections in total). Three bases are
reported because they measure different things:

- **section** - the whole manifest block (what the repo's own audit quotes: `mcp-surface.md` measured 59,286 B,
  re-measured here at 59,238 B; the 48-byte difference is that agent's rounding/hand-count, not a change).
- **wire-compact** - name + title + description + `inputSchema` + `annotations`. This is what an MCP client
  receives on `tools/list`.
- **wire-full** - wire-compact + `outputSchema` (structured content is schema'd in this example, so a real
  client receives it too). This is the upper bound.

Token figures use 4 bytes/token, the repo's own convention: the manifest header reports itself as
980,476 B / ~245k tokens (980,476/245,000 = 4.0).

### 3.2 What the 27 search tools cost today

| Family | Tools | section | wire-compact | wire-full | descriptions only |
|---|---|---|---|---|---|
| `hudu_search_<resource>` (+ `hudu_search_across_resources`) | 9 | 19,407 | 9,725 | 17,039 | 4,917 |
| `hudu_find_*` (12 identity lookups) | 12 | 26,228 | 13,722 | 23,135 | 6,438 |
| `hudu_find_*` (6 attached-record lists) | 6 | 13,603 | 7,616 | 12,002 | 3,172 |
| **Total** | **27** | **59,238** | **31,063** | **52,176** | **14,527** |

(Longest single description: 534 B average across the 18 `find_*` tools; the 9 search tools average 546 B.)

### 3.3 What the one tool costs

| | bytes | ≈ tokens |
|---|---|---|
| name + title | 51 | 13 |
| description (always on, every turn) | 2,085 | 521 |
| `inputSchema` | 898 | 225 |
| annotations (bound/helper tier) | 349 | 87 |
| **always-on total** | **3,383** | **846** |
| `outputSchema` (one compact shape, `SearchKnowledgeHit`) | ~781 (estimate: the mean of the 27 today) | 195 |
| **wire-full** | **~4,164** | **~1,041** |
| help payload, fetched on demand (`topic:"core"`) | 3,468 | 867 |
| help payload, `topic:"all"` | 5,114 | 1,279 |
| resources payload, fetched on demand | 3,417 | 854 |

### 3.4 The delta, and the honest headline

**9 tools retired (`hudu_search_<resource>` x8 + `hudu_search_across_resources`) -> 1 tool `hudu_search`:**

| basis | saved | ≈ tokens |
|---|---|---|
| section (manifest) | **16,107** | 4,027 |
| wire-full | **12,874** | 3,218 |
| wire-compact (every turn) | **6,342** | 1,586 |

**Break-even** (saved bytes / help-payload bytes, i.e. how many help fetches a session can afford before
consolidation stops paying):

| one help fetch costs | break-even on the compact saving |
|---|---|
| `topic:"core"` 3,468 B | **1.8 calls** |
| `topic:"all"` 5,114 B | **1.2 calls** |
| `resources` 3,417 B | **1.9 calls** |
| `help:"core"` + `resources` (6,885 B) | **0.9 - i.e. fetching both once costs MORE than the saving** |

**The honest headline, stated plainly:** the consolidation of the 9 redundant search tools buys ~1.6k tokens
per turn compact, or ~4k tokens on the manifest basis. It does **not** buy the 15k tokens that
`PROPOSAL.md` §11.2 quotes, because that 15k is the whole 27-tool family, and 18 of those tools are not
search tools (12 exact-key identity lookups whose job search cannot do - `?search=` never sees
`primary_serial`, `mcp-surface.md` §0 - plus 6 misnamed attached-record lists). On the compact basis the
consolidation pays only if the model fetches `help` and `resources` at most once between them; on the manifest
basis it pays comfortably. **The stronger argument for consolidation is not the byte count - it is decision
cost and the manifest budget**: the manifest is 980 KB / ~245k tokens and cannot ship whole, so the model
cannot be given 27 similarly-named search tools and asked to choose; the 8 per-resource tools are provably
redundant (`across_resources` accepts the same 8 names), and an agent that picks the wrong one gets a
name-only answer to a body question. That is a correctness gain, and it is worth the 1.8-call break-even.

### 3.5 The ceiling option, measured and NOT recommended

If all 27 search/find tools were folded into `hudu_search` (identity resolution becoming `mode:"find"` with
`{resource, key, value}`), the saving would be:

| basis | saved | ≈ tokens |
|---|---|---|
| section | 55,938 | 13,985 |
| wire-full | 48,011 | 12,003 |
| wire-compact | 27,680 | 6,920 |

That is the only way to reach the quoted 15k tokens. I recommend against it (reasons and the 12/6 split in
§4, correctness objections in §7.2) and present the number so the trade is explicit rather than hidden behind
a headline.

---

## 4. Migration of the MCP surface

Nothing in this section touches the SDK's public exports. All 28 search/find helper operations stay callable
(`operations.searchAcrossResources`, `operations.resolveAny`, `articles.search`, the 12 `findBy*`, the 6
list-attached helpers). **This is an MCP projection change only** - the programmatic tier is the tier the SDK
promises, and additive-only still holds.

### 4.1 The 27, tool by tool

| Today | Action | Why |
|---|---|---|
| `hudu_search_articles`, `hudu_search_assets`, `hudu_search_companies`, `hudu_search_users`, `hudu_search_groups`, `hudu_search_websites`, `hudu_search_asset_passwords`, `hudu_search_password_folders` (8) | **RETIRE** (`exclude: true`) | Redundant: `hudu_search_across_resources` accepts the same 8 names, and all 8 are reachable as `hudu_search({"resources":[...]})`. Their one real gap - `company_id` on the cross-resource tool - is closed by the new tool's `company_id`. Their descriptions never said what is searched, which is how an agent concludes a body phrase is absent. |
| `hudu_search_across_resources` (1) | **FOLD IN + RETIRE** | Fully expressed by `hudu_search({"resources":[...], "snippetChars":0})`. Retiring it also retires its two defects: no `company_id`, and no per-resource error isolation (one 5xx losing every resource). Its operation `operations.searchAcrossResources` **stays in the SDK** unchanged. |
| `hudu_find_articles_by_slug`, `find_asset_passwords_by_slug`, `find_assets_by_serial`, `find_companies_by_domain`, `find_companies_by_slug`, `find_ip_addresses_by_address`, `find_lists_by_name`, `find_matchers_by_sync_id`, `find_networks_by_address`, `find_users_by_email`, `find_vlans_by_vlan_id`, `find_websites_by_slug` (12) | **KEEP, UNCHANGED** | Exact-key resolution. Live evidence: `?search=` never sees `primary_serial`, `primary_model`, `primary_mail`, field labels, or email (`users?search=` covers name only). Search cannot replace them, so folding them in would remove capability, not redundancy. Two description defects to fix while here (below). |
| `hudu_find_activity_logs_by_resource`, `find_expirations_by_resource`, `find_flags_by_flagable`, `find_labels_by_labelable`, `find_magic_dash_by_company`, `find_relations_by_endpoints` (6) | **KEEP, RENAME** to `hudu_list_activity_logs_for_resource`, `hudu_list_expirations_for_resource`, `hudu_list_flags_for_record`, `hudu_list_labels_for_record`, `hudu_list_magic_dash_for_company`, `hudu_list_relations_for_endpoints` | They are not identity lookups - they list attached records while their names promise one record. Renaming is a wire-level delete+add (an override writes `field:"name"`), curated, not a public-API change. **Fallback if the renames are judged too breaking:** keep the names and lead each description with "Lists the records attached to one record (not an identity lookup)". These are *not* search tools; the consolidation above is independent of this choice. |

**Result: the search family goes 9 -> 1 MCP tool; `find_*` count is unchanged at 18 (12 same name, 6 renamed).
Projected tools: 147 -> 139.** The new tool is the only addition.

### 4.2 Two description defects that survive otherwise (measured)

- `hudu_find_assets_by_serial` tells the model to prefer **`hudu_assets_listAllAcrossCompanies`**, which is
  never projected (`listAll` is excluded by rule 2). The model is told to prefer a tool it cannot call. The
  existing `prose-dangling` rule does not catch this: it verifies the *client* has the method, not that the
  *projection* exposes it.
- **48 projected tool descriptions name one of the 9 tools this change retires** (measured: 30 `get_*`
  sections name `hudu_search_across_resources`; `hudu_get_article`, `hudu_find_articles_by_slug`,
  `hudu_get_asset`, `hudu_find_companies_by_domain` and 14 others name a per-resource search tool). Every one
  becomes a dangling reference on the day the tools are dropped. Worse, this class already exists:
  **59 projected descriptions today name a tool name that is not in the projection at all** (22
  `hudu_archive_*` names for resources with no archive operation, and 22 `hudu_search_<resource>` names for
  resources that were never projected, e.g. `hudu_search_activity_logs`). The prose is generated from the
  plan, so the fix is in the plan/registry prose, and the guard is the new rule in §5.3.

### 4.3 `get_*` / `create_*` / everything else

Untouched. 85 mutation tools, the other helper-tier reads, the `getContext` tools and `hudu_resolve_any` keep
their names, schemas and descriptions. The new tool is additive to the read tier.

### 4.4 `examples/mcp-server.ts` - the concrete change (this is the gate break)

Measured: the example registers 20 core-tier tools, 7 of them in the search/find family:
`hudu_search_across_resources`, `hudu_search_companies`, `hudu_search_articles`, `hudu_search_assets`,
`hudu_search_asset_passwords`, `hudu_search_users`, `hudu_find_companies_by_domain`.

- **Remove 6 registrations**: `hudu_search_across_resources`, `hudu_search_companies`, `hudu_search_articles`,
  `hudu_search_assets`, `hudu_search_asset_passwords`, `hudu_search_users`.
- **Keep** `hudu_find_companies_by_domain` (identity lookup, unchanged) and `hudu_resolve_any`.
- **Add** `hudu_search` with (a) a zod schema mirroring §1.3 - `mode` as `z.enum(['search','help','resources'])`
  with `.default('search')`, `query` optional, `resources` reusing the existing `SEARCHABLE_RESOURCES` enum
  (which must stay exactly the 8 names the registry declares), `topic` enum, and the option fields; (b) the
  **curated description string byte-for-byte** - `--check-example` fails on "a description that is not the
  curated one", so the example should import or re-use one exported const rather than re-typing 2,085 bytes;
  (c) an `outputSchema` that covers all three modes (a discriminated union on `mode`), or the check's
  unbounded-read/description rules will not be the only problem.
- Net: the example's registered set goes 20 -> 15 (20 - 6 + 1). The file's own header and its `// This is a REFERENCE CONSUMER` note both say "the curated manifest projects 147 tools, and this file exposes the core tier (20)", so both numbers must be updated in the same commit (147 -> 139, 20 -> 15).

### 4.5 Curation records to write (counts)

- **+4 records** for the new tool: `name` (`hudu_operations_searchKnowledge` -> `hudu_search`), `title`,
  `description` (the 2,085 B text), and `inputSchema.opts` (to force the enums on `mode`, `resources`,
  `topic` - see §1.3 for why the generator may otherwise emit `items:{type:"object"}`).
- **+1 `annotations.bounded`** record so the manifest states the bound in the tool's own annotations.
- **+9 `exclude: true`** records (the 8 per-resource searches + across_resources), each with the reason from
  §4.1. They will appear under "Excluded by curation", which is the documented, auditable way to shrink.
- **+18 records** if the 6 renames are taken (6 x name; +6 title; +6 description) - optional, and orthogonal.
- Overrides are validated: an override naming an unknown tool or field exits non-zero, so a typo here fails
  the projection rather than diverging silently.

---

## 5. Gate impact

### 5.1 The plan row (`capabilities.plan.json` -> `operations[]`)

All 20 row keys are present; `status` is `implemented` on the way to `tested` (a `--ship` check fails on
anything not `tested`, so the row must be driven planned -> implemented -> tested, not left planned).

```json
{
  "endpoint": null,
  "primitive": null,
  "specialOp": null,
  "vendorFilters": [],
  "search": null,
  "helper": "operations.searchKnowledge",
  "helperBasis": "composite",
  "helperRationale": "The vendor cannot search KB article bodies, cannot rank, and has no snippet field, so a body-aware ranked search cannot be expressed as a request. Without this helper every agent re-implements a bounded page walk, an HTML-stripped snippet extractor and a fuzzy scorer, and reads a capped, body-blind scan as 'not in the knowledge base'. It also gives agents one search entry point whose contract (bounds, degradation, score bands) is the same on every resource, instead of 27 tools with overlapping names and no shared semantics.",
  "effect": "read",
  "flags": [],
  "dryRun": false,
  "metadata": {
    "purpose": "Ranked, fuzzy search across Hudu: knowledge-base articles first, then assets and the other text-searchable resources.",
    "usage": "Mode-selecting helper. mode:\"search\" (default) needs query and returns ranked hits with plain-text snippets, scores and the follow-up call; bounded by limit (default 8, max 25), snippetChars (default 200, max 400) and a 500-record/4-page scan cap per resource, with complete/truncation/degraded reporting every bound that bit. mode:\"help\" returns how to use the tool (topic slices). mode:\"resources\" returns the searchable-resource table derived from the plan rows that declare a search vendor filter. A field the selected mode cannot honour throws CONFIG_ERROR naming the fields it does honour.",
    "preferredWhen": "Preferred over operations.searchAcrossResources and every per-resource search helper whenever the query is imperfect, spans a body-only term, or the caller needs to know WHY a result matched. Not for identity lookup by exact key (use resolve/findBy*) and not for paging (use the resource's list).",
    "related": [
      "operations.searchAcrossResources",
      "operations.resolveAny",
      "articles.get",
      "assets.get"
    ]
  },
  "compact": "SearchKnowledgeHit",
  "resolution": {
    "basis": "client-scan",
    "maxScanRecords": 500,
    "maxScanPages": 4
  },
  "staleCheck": null,
  "redaction": "credentials",
  "errors": [
    "CONFIG_ERROR",
    "NETWORK_ERROR",
    "RATE_LIMIT"
  ],
  "tests": [
    {
      "id": "operations.searchKnowledge.body",
      "file": "test/operations.test.ts",
      "title": "matches an article by a body-only token that the vendor search cannot find"
    },
    {
      "id": "operations.searchKnowledge.fuzzy",
      "file": "test/operations.test.ts",
      "title": "matches a misspelled query token within the documented edit distance"
    },
    {
      "id": "operations.searchKnowledge.rank",
      "file": "test/operations.test.ts",
      "title": "orders hits by score and breaks ties on updated_at then resource and id"
    },
    {
      "id": "operations.searchKnowledge.snippet",
      "file": "test/operations.test.ts",
      "title": "returns a plain-text snippet with HTML stripped and the length capped"
    },
    {
      "id": "operations.searchKnowledge.caps",
      "file": "test/operations.test.ts",
      "title": "reports scanned, complete and truncation and never claims a truncated scan is complete"
    },
    {
      "id": "operations.searchKnowledge.degraded",
      "file": "test/operations.test.ts",
      "title": "reports degraded body-not-indexed with advice instead of an empty list alone"
    },
    {
      "id": "operations.searchKnowledge.help",
      "file": "test/operations.test.ts",
      "title": "mode help returns the requested topic and makes no vendor request"
    },
    {
      "id": "operations.searchKnowledge.resources",
      "file": "test/operations.test.ts",
      "title": "mode resources returns exactly the resources whose plan row declares a search vendor filter"
    },
    {
      "id": "operations.searchKnowledge.mode-guard",
      "file": "test/operations.test.ts",
      "title": "rejects a field the selected mode cannot honour and rejects a missing query in search mode"
    },
    {
      "id": "operations.searchKnowledge.redaction",
      "file": "test/operations.test.ts",
      "title": "forces snippetChars to 0 for asset_passwords and password_folders and reports credentials redaction"
    }
  ],
  "group": "operations",
  "status": "implemented"
}
```

Row-specific notes:

- `helperBasis: "composite"` + `resolution.basis: "client-scan"` with **both** caps: `resolution-caps`
  demands both keys for a client-scan basis, and `composite` is the precedent for a helper that composes
  other helpers (`operations.searchAcrossResources`, `operations.resolveAny`).
- `redaction: "credentials"` (not `"none"`): the helper can surface `asset_passwords` / `password_folders`
  rows. Their snippets are forced to 0 and the response says `meta.redaction:"credentials"`. The checker's
  `redaction-value` accepts exactly this value; declaring `"none"` while the tool can return password names
  would be the lie.
- `errors` lists `CONFIG_ERROR` (required on every row), `NETWORK_ERROR`, `RATE_LIMIT`. **Do not** add
  `RESOLUTION_TRUNCATED`: a capped scan is a *field* (`complete:false` + `truncation`), not a throw, and
  `errors-vocabulary` would pass while the contract lied.
- `metadata.related` entries all have registry records (`operations.searchAcrossResources`,
  `operations.resolveAny`, `articles.get`, `assets.get`) - `related-dangling` checks this.
- `metadata.usage`/`purpose`/`preferredWhen` name only operations the client can call (`prose-dangling`).
  In particular the new prose must **not** name a `hudu_index_knowledge` tool: no such tool exists, and a
  model told to call it will fail. The help payload says "call again in a moment" instead.
- `tests[]`: 10 rows, at least one per mode (help, resources, mode-guard, redaction). `test-title` requires
  each title to exist verbatim in `test/operations.test.ts` at `status:"tested"`.
- `compact: "SearchKnowledgeHit"` must be a declared shape in `src/types/**` (`compact-shape-unknown`), and
  the registry record needs a real `outputSchema.drops` array with `dropsUnresolved:false`
  (`helper-compact-drops`) - declare what the compact hit drops (article HTML `content`, the asset `fields`
  array, `share_url`, `object_type`).

### 5.2 Registry / emission

`capabilities:build` regenerates `capabilities.json` + `src/capabilities.ts` (the plan hash changes, so
`emission-planhash` fails until it runs), then `mcp:project` regenerates `MCP_TOOL_MANIFEST.md`
(`manifest-planhash` also asserts the registry record count, which goes 225 -> 226).

### 5.3 New checker rules this design needs

Four rules, all mechanical:

1. **`searchable-resource-parity`** - a tool/mode that advertises searchable resources must advertise exactly
   the set of resources whose plan list row declares a text filter (`search === "search"`, or a documented
   client-side filter). Concretely: the set in `operations.searchKnowledge`'s `resources` enum and in the
   `mode:"resources"` payload must equal `{r : plan row of r has search !== null}` (8 today). Rationale, from
   ground truth: a resource without a declared text filter *silently ignores* `?search=` and returns an
   unfiltered page, so advertising it is a false-match generator for every query. This rule is the
   enforceable form of `mcp-surface.md`'s "a search tool may only claim a match from a resource whose registry
   row documents a text filter".
2. **`help-mode-documents-resources`** - a record whose schema declares a help/meta mode must (a) carry a
   `modes` map naming, per mode, the fields it honours and the fields it rejects, and (b) have its `resources`
   payload generated from the plan rather than authored by hand. Fail when a mode names no resources, when the
   payload is a static string literal in the source, or when a mode's honoured-field list omits a field the
   schema advertises.
3. **`mode-honours-fields`** - extends `inputSchema-conditional-field`: every advertised field must be
   honoured by at least one declared mode, and a field honoured by exactly one mode must say so in its
   description. This is what stops the god-tool from growing a field that no mode uses (the failure mode that
   turns a facade into a bag of unrelated options).
4. **`prose-dangling-projection`** - a *projected tool's description* must not name a tool name that is
   absent from the projection (today's `prose-dangling` checks the plan/registry prose against *client
   methods*, which is why 59 projected descriptions currently name tools the model cannot call: 22
   `hudu_archive_*`, 22 `hudu_search_<resource>`, 2 `hudu_create_*`, plus `hudu_update_magic_dash`,
   `hudu_update_relation`, `hudu_get_`). **Sequencing:** this rule cannot ship as a failure - it would fail
   immediately on the ~48 sections this change strands plus the 59 pre-existing ones. Land it as a warning,
   fix the plan prose, then flip it to a failure. Expect the fix to be a `derive-plan.mjs` pattern change,
   since the prose is generated.

### 5.4 What fails first (ordered)

1. **`mcp:project -- --check-example`** - the example registers 6 tools that no longer exist, and its new
   tool's description must equal the curated one byte-for-byte. This is the most likely break and it must be
   fixed in the same commit as the projection.
2. **`emission-planhash` / `manifest-planhash`** - editing the plan without re-running
   `capabilities:build` + `mcp:project`. Mechanical, immediate, expected.
3. **`mode-honours-fields`** (new) if `mode` is injected by an override but is not on the operation's
   signature - the schema would advertise a field the operation cannot honour.
4. **`inputSchema-conditional-field`** if `topic` is advertised for `mode:"resources"` without the rejection
   rule being implemented; the operation must actually reject it.
5. **`searchable-resource-parity`** (new) if the `resources` enum is typed as a named alias (which renders as
   `items:{type:"object"}`, degenerating to "no enum at all") or if the `resources` payload is hand-written.
6. **`compact-shape-unknown` / `helper-compact-drops` / `resolution-caps` / `helper-tests` /
   `helper-usage` / `preferredWhen` / `test-title`** - the standard helper-row obligations; all satisfiable by
   the row above, none automatically.
7. **`--ship`** - only after the row reaches `tested` with the verbatim test titles.

---

## 6. Risks of consolidation, honestly

1. **Discoverability of a generic name.** `hudu_search` competes with nothing, but a model may treat a
   one-word name as a keyword search and never read past the first line.
   *Mitigation:* the description's first clause names all three modes; `mode` defaults to `search` so the
   common call is unchanged; every empty/degraded response carries `degraded.advice` telling the model that
   `mode:"help"` exists; each hit carries `fetch`, which names the exact follow-up tool.
2. **An extra round trip to learn capabilities.** Help costs one call and ~3.5 kB, and a model that does not
   make that call will mis-read a bounded result. *Mitigation:* the facts that must never be missed are in the
   2,085-byte always-on description (defaults, bounds, the `degraded` rule, "not an identity lookup"); the
   help payload only carries detail. The CONFIG_ERROR for a mis-used mode lists the legal fields, so a *failed*
   call doubles as help. Break-even measured at 1.2-1.9 help fetches (§3.4) - a session must not fetch help
   more than ~twice, which is why the always-on description carries the honesty rules rather than the help
   payload doing it.
3. **The model never realises help exists.** *Mitigation:* stated first in the description, named in
   `degraded.advice`, named in every CONFIG_ERROR, and the response's `mode` echo documents the other modes in
   the transcript. Residual risk after that: low but not zero - it is the honest cost of progressive
   disclosure, and it is why the fallback in 6.6 exists.
4. **A god-tool.** One tool with three jobs is harder to reason about than three tools, and it invites more
   modes ("index", "status", "find", "related") until the schema is a bag. *Mitigation:* a closed 3-value
   enum with a checker rule (`mode-honours-fields`) that fails on any field no mode honours; the meta modes
   perform no network I/O and no state change, so they cannot be an accidental action; the implementation is
   three internal modules behind a few-line dispatcher; and §7.1 names the modes I refuse to add.
5. **Mode confusion in the client.** If a client mishandles a defaulted field or a conditional requirement,
   `mode:"help"` could be sent as a search that throws, or worse, a search could be silently served as help.
   *Mitigation:* R2/R3/R4 in §1.4 - missing `query` throws (never falls back to help), an unhonoured field
   throws (never ignored), and every response is tagged with the mode that ran; a distinct top-level shape
   per mode means a mis-tagged response is visibly wrong.
6. **The fallback, stated up front.** If the enum proves unworkable for a real client, the design degrades to
   **two** tools with no shared schema: `hudu_search` (query + options only) and `hudu_search_help` (a `topic`
   enum only, no `query` field at all). This costs ~700 extra always-on bytes and one extra tool, and it is
   unambiguous by construction. I do not recommend starting there, but it is a real escape hatch, not a
   rewrite.

---

## 7. What I would NOT do

1. **No fourth mode.** Rejected: `mode:"index"` (warming/status), `mode:"status"`, `mode:"find"`,
   `mode:"related"`. Index state is already reported in `meta.index` on every search, and `degraded.advice`
   tells the model what to do about a cold index; an explicit `find` mode would move exact-key resolution -
   the most correctness-critical path, and the one whose key set differs per resource - behind a resource
   enum, where one wrong resource name costs a round trip and the promise "this tool resolves one record"
   stops being readable from the name.
2. **No folding of the 18 `find_*` tools into this one.** It is the only way to reach the 15k-token headline
   (§3.5), and it costs capability: search cannot resolve `primary_serial`, field labels or email, and 6 of
   the 18 are not identity lookups at all. I would rather publish the honest 1.6k/turn number than a 15k
   number that hides a capability loss.
3. **No hand-written resources table.** It must be derived from the plan (rule 2, §5.3). A hand-written table
   in an LLM's context drifts from the registry and then answers "what is searchable" wrongly.
4. **No `expand`, no full bodies, no paging.** The tool returns snippets and a `fetch` instruction;
   `hudu_get_article` remains the only way to put a body in context, and enumeration stays with `hudu_list_*`.
5. **No writes and no side effects in the meta modes.** `help` and `resources` make no vendor request, build
   nothing and cache nothing, so they can never be the reason a call costs money or mutates index state.
6. **No quota of my own.** No second popularity/threshold knob, no `strict` flag, no synonyms mode; every
   field I add is a field the model must consider on every call.
7. **No change to the SDK's 28 helper operations, and no new per-resource search methods.** The programmatic
   tier keeps its shape; this is a projection decision.

---

## 8. Deltas against the prior documents (so the reader knows what moved)

| Prior position | This document |
|---|---|
| `PROPOSAL.md` §2 / `mcp-surface.md` §2: MCP tool `hudu_search_knowledge`, execute-only | renamed **`hudu_search`**, three modes (search/help/resources) under one `mode` enum, because two of three modes are not knowledge-base reads and the approved operation name is kept only on the SDK side |
| `mcp-surface.md` §2 options (`snippet_length`, `resources` = articles+assets only) | `snippetChars` (proposal §7), and `resources` covers the **8** text-searchable resources, with `asset_passwords`/`password_folders` redacted (snippets forced to 0) instead of excluded - excluding them would have deleted a real capability from the retired per-resource tools |
| `mcp-surface.md` §1 "27 -> 14" | **9 search tools -> 1**; the 18 `find_*` survive (12 unchanged, 6 renamed). The 14-tool target counted the identity lookups as part of the search family; they are not |
| `mcp-surface.md` `matched:{field,term,...}` / `empty_reason` / `capped` | the engine's vocabulary wins: `match:{fields,terms,coverage,fuzzy}`, `meta.complete`/`meta.truncation`/`meta.degraded` (`PROPOSAL.md` §7 already said the engine's names win) |
| `PROPOSAL.md` §11.2 "~59 KB / ~15k tokens saved" | measured basis split; the achievable saving is **6,342 B compact / 16,107 B section**, and the 15k figure only holds if the identity lookups fold in, which this document recommends against |
| no position | §5.3's four checker rules, and the sequencing warning: `prose-dangling-projection` must land as a warning first, because ~48 descriptions this change strands (plus 59 already dangling) fail it on day one |

---

## 9. Evidence log, and what is UNVERIFIED

**Measured in this session (repo artefacts, read-only):**
`MCP_TOOL_MANIFEST.md` - 148 tool sections; the 27 search/find sections totalling 59,238 B; per-family
section/wire byte counts; 13,940 B of descriptions; 7,528 B of `inputSchema`; 21,113 B of `outputSchema`;
48 projected sections naming one of the 9 tools this change retires; 59 projected sections naming a tool name
absent from the projection. `capabilities.plan.json` - 225 rows, exactly 8 with `search === "search"` and
their exact `vendorFilters`; `helperBasis` vocabulary (server-filter 56, client-scan 5, workflow 3, composite
3); 17 rows with `redaction:"credentials"`. `capabilities.json` - `operations.searchAcrossResources` ships
`resources` as `{"type":"array","items":{"type":"object"}}` (the enum is lost by the named alias).
`MCP_TOOL_OVERRIDES.json` - 644 records, 56 `exclude`, `inputSchema.opts` replacement mechanism.
`scripts/check-capabilities.mjs` - all rule ids as listed in §5.4. `scripts/generate-capabilities.mjs` -
`jsonType` renders `Array<'a'|'b'>` with an enum and a named alias without one.
`examples/mcp-server.ts` - 20 registered core tools, 7 in the search/find family, named in §4.4.
Payload byte counts in §2.1/§3.3 were computed from the exact strings quoted in §1.2/§2.2/§2.3.

**UNVERIFIED (nothing below was executed, and no live call was made for this document):**
- the engine, the operation, the schema, the mode guards and the payloads do not exist - every behavioural
  claim is a specification, not a measurement;
- all token figures use the 4 B/token convention, not a real tokenizer;
- the new tool's `outputSchema` byte figure is an estimate (the mean of the existing 27);
- the four checker rules in §5.3 are proposals; `metadata.modes` is a new key on the plan row and, although
  the checker today ignores unknown `metadata` keys (no rule matches them), that tolerance is unverified;
- `composite` + `resolution.basis:"client-scan"` passing `resolution-caps` is inferred from the rule's text,
  not run;
- the `NOT SEARCHABLE` rows in the resources payload come from the registry, not from a fresh live probe
  (only `activity_logs`, `expirations`, `folders` were previously confirmed to return unfiltered pages);
- the `hudu_search_help` fallback of §6.6 is a design, not a built artefact.
