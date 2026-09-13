# Progressive disclosure across the WHOLE MCP tool surface

STATUS: DESIGN ONLY. No file under `src/`, `test/` or `scripts/` was changed; nothing committed.
Scratch scripts live in `/tmp/pd/` (`measure.py`, `v1.py`, `v3.py`, `v5.py`).
Builds on `MCP_TOOL_MANIFEST.md`, `scripts/project-mcp-tools.mjs`, `scripts/check-capabilities.mjs`,
`capabilities.plan.json`, `capabilities.json`, and `.run/design/search/PROPOSAL.md` §11.2 — none of their
decisions is re-derived here (§8 lists the deltas). Every number below was measured; §11 is the evidence log.

---

## 0. Headline

The client-visible surface today is **147 tools / 324,688 bytes / 74,949 tokens** (measured, §1). Every MCP
client pays that on every turn. The proposal is a **16-tool core (6,294 tokens, −91.6 %)** plus three
always-present META tools — `hudu_catalog`, `hudu_describe`, `hudu_invoke` — that make **all 225 registry
operations reachable on demand**, including the **78 operations that no MCP client can reach today**.

The one thing most likely to break first is `npm run mcp:project -- --check-example`: it asserts the example
server registers only curated tools with the curated descriptions, and the META tools are not in the curation
(§8.1).

---

## 1. The status quo, measured

Method: parse the per-tool sections of `MCP_TOOL_MANIFEST.md` into the `tools/list` entry a client receives
(`name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`), serialize compact JSON, count
bytes and `cl100k_base` tokens (`uv run --with tiktoken python /tmp/pd/measure.py`).

| Measurement | Value |
|---|---|
| `MCP_TOOL_MANIFEST.md` on disk | **981,084 bytes** |
| Client-visible `tools/list` payload, 147 tools, compact JSON | **324,688 bytes / 74,949 tokens** |
| …descriptions only | 15,187 tokens |
| …`inputSchema` only | 23,861 tokens |
| …`outputSchema` only | 23,941 tokens |
| …`annotations` only | 8,328 tokens |
| Tool count | 147 (62 helper-tier, 85 mutations, 0 primitive reads) |
| Median tool | 509 tokens |
| Top 15 tools | **14,632 tokens (19.5 % of the surface)** |
| Largest single tool | `hudu_update_company` 1,347 tokens; `hudu_create_company` 1,258 |
| Largest description | `hudu_get_asset_password` 165 tokens (top 5 sum 786) |

**Correction to the brief (and to `PROPOSAL.md` §11.2).** The "980 KB / ~245k tokens" figure is the *markdown
manifest*, not the client-visible surface. The payload a client actually re-reads every turn is 324,688 bytes /
**74,949 tokens** — 3× smaller than the quoted number. The direction of the argument is unchanged; the
magnitude of the problem is 75k, not 245k. Use 74,949 whenever this design is compared against a budget.

### 1.1 Split across the tiers that exist

The brief's "core / extended" tier annotation **does not exist in the projection**. Measured:
`grep -c '"field": "tier"' MCP_TOOL_OVERRIDES.json` → **0**; the only `tier` values in the manifest are the
mechanical `helper` / `primitive-write` annotations. The one real core list in the repo is the tool set
registered by `examples/mcp-server.ts` ("this file exposes the core tier (20)").

| Set | Tools | Bytes | Tokens |
|---|---|---|---|
| All projected tools | 147 | 324,688 | 74,949 |
| helper tier (`tier="helper"`) | 62 | 144,056 | 33,248 |
| mutation tier (`tier="primitive-write"`) | 85 | 180,949 | 42,124 |
| reference server "core tier" (`examples/mcp-server.ts`) | 20 | — | **13,859** (name+description only: 2,318) |

### 1.2 What a client must hold to do common work

MCP has no per-call schema fetch: the client holds the whole `tools/list`. So "how many tools to do X" is
"what the client must carry to be able to do X".

| Workflow | What must be present | Cost carried every turn |
|---|---|---|
| Search anything | `hudu_search_across_resources` (+ 8 per-resource search tools, 27 search/find tools total) | helper tier = 33,248 tokens |
| Retrieve one record | the right `hudu_get_*` / `hudu_find_*_by_*` out of 62 helpers | same 33,248 tokens |
| Mutate with dry-run | the right writer out of 85 | mutation tier = 42,124 tokens |
| Any other workflow | union of the above | 74,949 tokens |
| **Any registry operation not projected** | **impossible** — see 1.3 | — |

### 1.3 The reachability hole (measured)

The registry has **225 operations** (`capabilities.json`: 158 `primitive` + 67 `helper`; effects: 131 read,
66 write, 28 destructive; 36 resources). The projection exposes 147. The other **78 are unreachable from any
MCP client**:

- 22 excluded by mechanical rule (10 `listAll`/`listPages` unbounded reads, 12 binary/download resources),
- 56 excluded by curation `exclude` overrides (duplicate-outcome merging).

Curation removes the *tool* but the *capability* still exists in `CAPABILITIES_REGISTRY`. Today an agent that
needs one of those 56 has no path at all, and no way to learn it exists.

---

## 2. Mechanism comparison

| Candidate | How it works | Verdict |
|---|---|---|
| **(a) Small CORE + META tools that discover/describe/execute on demand** | `tools/list` carries ~16 curated tools; `hudu_catalog` returns rows for all 225 operations; `hudu_describe` returns one full schema; `hudu_invoke` executes by name with registry validation | **RECOMMENDED.** Every host supports it (it is just tools); model-driven; the long tail is reachable *without* its schema being shipped; catalog cost is paid only on turns that ask for it |
| **(b) Tier-gated exposure, configured per client** | host env/flag picks `core` / `extended` / `all`; the server registers that subset | Keep as a **host knob on top of (a)**. It is static per process, it needs a restart/reconnect (most hosts fetch `tools/list` once), and it does not fix reachability — an `extended` client still cannot reach the 78 unprojected operations. Also `core` must then be hand-maintained while `extended` (135 tools / 68,527 tokens) is the same context problem again |
| **(c) One dispatcher tool with an `operation` parameter, as the primary surface** | `hudu_call({operation, input})` for everything | **Do not use as the primary surface.** It is a *trap* for four concrete reasons: (i) the schema collapses to `{operation: string, input: object}` — the 111,539 bytes of per-field `required`/`enum`/description structure the generator produces is invisible at tool-choice time; (ii) 225 distinct outcomes share one description, so the model has one paragraph to choose from instead of a name and a purpose (the current surface spends 15,187 description tokens precisely to disambiguate); (iii) all argument errors move from schema-validation to runtime HTTP attempts; (iv) it makes every call untyped for hosts that key on `inputSchema` for UI/validation. (a) uses exactly this mechanism, but only as the **escape hatch** for capabilities that are *not* curated, always after `hudu_describe` |
| **(d) MCP-native: server-side filtered `tools/list`, resources, prompts** | filter the list per session; expose the catalog as a `hudu://catalog` resource or a prompt | **Partially usable, partly out of reach of this repo.** A *projection document* cannot control any of it: `MCP_TOOL_MANIFEST.md` is documentation, and `tools/list` is produced by the server process. What the repo can control: the projection + gates, the SDK-side catalog/describe/invoke primitives, and the reference server. MCP-level notes: **resources** need explicit host/user attachment, so discovery would depend on the user, not the model — wrong direction; **prompts** are user-invoked, not model-invoked — unusable for model-driven discovery; **`notifications/tools/list_changed`** lets a server announce a changed list, but whether a given host re-fetches is host-specific — I did not test any host, so dynamic per-turn gating is **UNVERIFIED and must not be the load-bearing mechanism** |

### 2.1 Recommendation

**(a) as the mechanism, (b) as an opt-in host knob, (c) only as the on-demand escape hatch.**

- Purely inside this repo: the CORE definition + the generation of it, the catalog/describe payloads (both
  generated from `CAPABILITIES_REGISTRY`), the SDK-side `operations.invoke` (additive public API, §6), the
  checker rules (§7), and the example server.
- Needs the MCP server host: which tools are registered in a session, whether an `extended` profile is enabled,
  whether the host re-fetches on `tools/list_changed`, and any per-session filtering. The projection document
  can only *state* the contract and gate the generated artifacts.

---

## 3. The CORE set, by rule

**Inclusion rule (stated so it is checkable, and so it is not taste):**

> CORE = every tool an agent needs to (R1) **discover** any capability, (R2) **identify itself to the tenant**,
> (R3) **find a record it cannot name**, and (R4) **read one record of each workflow resource**. A write is
> NOT in core: writes are reachable through the escape hatch, which enforces dry-run (§6). The workflow
> resources are the repo's own authored group A (`scripts/derive-plan.mjs` GROUPS.A — "the workflow
> resources"), so the rule inherits an existing, versioned definition instead of a new opinion.

Measured coverage: **9 / 9 group-A resources**, 1 read entry each. The read entry is the helper the manifest
already retains for that resource (no new curation).

| # | Tool | Rule | Backing operation |
|---|---|---|---|
| 1 | `hudu_catalog` | R1 (new) | — serves the whole registry |
| 2 | `hudu_describe` | R1 (new) | — |
| 3 | `hudu_invoke` | R1 (new) | — whole registry, by name |
| 4 | `hudu_get_api_info` | R2 | `api_info.resolve` |
| 5 | `hudu_search_across_resources` | R3 | `operations.searchAcrossResources` |
| 6 | `hudu_resolve_any` | R3 | `operations.resolveAny` |
| 7 | `hudu_search_knowledge` | R3 (new, `PROPOSAL.md`) | `operations.searchKnowledge` |
| 8 | `hudu_get_company_context` | R4 companies | `companies.getContext` |
| 9 | `hudu_get_article_context` | R4 articles | `articles.getContext` |
| 10 | `hudu_get_asset_context` | R4 assets | `assets.getContext` |
| 11 | `hudu_get_asset_layout` | R4 asset_layouts | `asset_layouts.resolve` |
| 12 | `hudu_search_asset_passwords` | R4 asset_passwords | `asset_passwords.search` |
| 13 | `hudu_search_websites` | R4 websites | `websites.search` |
| 14 | `hudu_get_folder` | R4 folders | `folders.resolve` |
| 15 | `hudu_search_password_folders` | R4 password_folders | `password_folders.search` |
| 16 | `hudu_search_groups` | R4 groups | `groups.search` |

| CORE cost | Value |
|---|---|
| Tools | **16** |
| Full wire (name+title+description+inputSchema+outputSchema+annotations) | **6,294 tokens** (12 existing tools + 3 new meta; `hudu_search_knowledge` not yet costed — its schema is in `PROPOSAL.md` §2, ~150 tokens, so the shipped figure will be ≈6,450) |
| Without `outputSchema`+`annotations` | 3,122 tokens |
| Descriptions only | 1,458 tokens |
| Reduction vs today | **−91.6 %** |
| 20-turn session, always-present surface | 1,499,000 → **126,000** tokens |
| Degraded profile if the budget is tighter still | meta tools only = **124 tokens** (3 tools) |

Non-core ("extended") = **135 tools / 68,527 tokens**, never shipped whole.

---

## 4. The catalog payload (discovery, on demand)

`hudu_catalog` returns rows generated from `CAPABILITIES_REGISTRY` + the plan's `metadata`:

```json
{"op":"companies.update","tool":"hudu_update_company","summary":"Update a specific company.",
 "when":"Preferred over create or delete when the record exists and only some fields change.",
 "effect":"write","requires":["id","data"],"dry_run":true}
```

Fields per row: `op` (canonical registry key — the name `hudu_invoke` takes), `tool` (present only when the
operation is exposed as its own tool), `summary` (`metadata.purpose`), `when` (`metadata.preferredWhen`),
`effect` (`read|write|destructive`), `requires` (top-level required argument names), `dry_run`; plus
`reachable:false` + `reason` for operations that the escape hatch refuses (§6).

| Catalog size | Value |
|---|---|
| All 225 rows | 46,359 bytes / **10,161 tokens** |
| One page (`limit` default 40) | **1,772 tokens** |
| Median row | 46 tokens (max 79) |
| The 78 currently-unreachable rows alone | 3,351 tokens |

**Budget:** `limit` defaults to 40 and hard-caps at 100 (the SDK's existing helper bound), so a single catalog
call can never exceed ~4,500 tokens; the full 10,161-token dump requires an explicit `limit` and is never the
default. `offset` supports paging.

`hudu_describe({operation})` returns `inputSchema`, the registry's first `examples` entry, `effect`,
`flags` (sensitive / requiresApproval), `dry_run`, `errors`, `related`, `preferredWhen`, and
`reachable` + `why_not` when the operation is not invocable.
Measured: **median 180 tokens**, largest (`companies.update`) 753 tokens, 48,149 tokens for all 225 if an
agent were to describe every one (it never should).

**Discovery round trip** = catalog page (1,772) + describe (180) + invoke → **≈2.0k tokens, once per new
capability**, versus 68,527 tokens to carry the extended tier permanently.

---

## 5. Invoke: reachability without shipping schemas

`hudu_invoke({operation, input?, dry_run?, confirm?})`.

Resolution and validation:

1. `operation` is an **exact key lookup** in `CAPABILITIES_REGISTRY` (`src/capabilities.ts`, already generated;
   `CAPABILITY_NAMES` / `getCapability` exist). Unknown → `CONFIG_ERROR` naming the nearest keys. No fuzzy
   execution.
2. The input is **validated against the registry record's `inputSchema` before any HTTP request**: unknown
   fields, missing required fields, wrong types and out-of-enum values are refused with the field path. The
   registry schema and the catalog row come from the same record, and `CAPABILITIES_PLAN_HASH` ties both to
   `capabilities.plan.json`, so catalog and validation cannot drift independently.
3. Execution delegates to the **same code path as the typed method** — one generated dispatch
   (`operations.invoke`, §6), so retries, pagination caps, the stale-object guard, redaction and the error
   vocabulary are the typed method's, not a second implementation.

### 5.1 Where the safety actually comes from

Plainly: **not from the tool list.** A shorter list is not a security control; it is a context control. The
safety comes from four places, in descending order of strength:

1. **The SDK guards that already exist and are shared with the typed methods.** Dry-run
   (`{dryRun:true}` → `DryRunResult`, no request issued), the `requiresApproval` / `POLICY_DENIED` refusal on
   bulk deletes, the identifier and scan caps (`RESOLUTION_TRUNCATED` instead of a partial answer), the
   `expectedUpdatedAt` stale guard, sensitive-field redaction, `refuseDryRunInPayload`,
   `refuseClientScan`. `hudu_invoke` reaches the long tail through these guards, so it cannot do anything the
   typed surface could not do.
2. **Schema validation before HTTP** (rule 2 above).
3. **Explicit refusals for the operations the projection excludes**, so the exclusion rule is preserved rather
   than bypassed through the back door:
   - `listAll` / `listPages` → refused: *"unbounded read — never exposed as a tool"*, with the bounded
     alternative named from `related`;
   - binary/download resources (`photos`, `public_photos`, `uploads`, `exports`, `s3_exports`) → refused,
     reason `binary/download surface`;
   - each refusal is itself a **catalog row** with `reachable:false` + `reason`, so the agent learns "exists,
     not callable here" instead of "does not exist".
4. **Write governor, not a security boundary.** No write executes through `hudu_invoke` unless
   `dry_run:true` was used first for that operation; destructive/approval-gated operations additionally require
   `confirm` to equal the operation name (deliberate act, stateless, trivially checkable). It stops accidental
   writes; it does not stop a determined caller, and the design must not pretend it does.

The weak point, named honestly: **the validator is a second implementation of the generator's schema
language.** `inputSchema` is not JSON Schema — it is the generator's own vocabulary (`type`, `required`,
`fields`, `items`, `enum`, `variants`, `anyOf`, `typeName`). If a shape appears that the validator does not
handle, the operation silently becomes *unvalidated* while still looking validated. Mitigation is a gate, not
optimism: §7 G4 enumerates every shape/key in the registry and requires each to be handled **and** tested.

---

## 6. What must be added, and where

| Piece | Where | Kind |
|---|---|---|
| `CATALOG` rows + `describe` payload builder, generated from `CAPABILITIES_REGISTRY` | `src/capabilities.ts` (generator output) | additive export; planHash-gated like the rest |
| `operations.invoke(operation, input, opts)` — resolve → validate → dispatch → typed result | `src/operations/operations.ts` | **additive public API** (helper tier and every primitive stay callable — nothing is removed) |
| `hudu_catalog` / `hudu_describe` / `hudu_invoke` registration + the CORE profile list | `examples/mcp-server.ts` (reference server) | host-side |
| CORE profile selection (`HUDU_MCP_PROFILE=core|extended|all`) | reference server env | host-side, optional |
| Gate rules G1–G7 | `scripts/check-capabilities.mjs`, `scripts/project-mcp-tools.mjs` | gates |

If `operations.invoke` is deliberately not added to the SDK, the same tool is implementable entirely
host-side — but then validation is hand-written per host, is not shared with the typed methods, is not covered
by the SDK's tests, and cannot be gated by G4. That is the unsound version and is not recommended.

---

## 7. Honesty and gates

### 7.1 How a model knows a capability exists but is not loaded

- The **`hudu_catalog` description itself** is the signal: it states that 225 operations exist and that the
  tool list is a subset. A model reading its own tool list learns there is a long tail and how to reach it.
- Every catalog row carries `op` (real registry key), `tool` when exposed, `effect`, `dry_run` and `requires`.
- Operations the escape hatch refuses get `reachable:false` + `reason` + the bounded alternative.
- `hudu_describe` restates `reachable` / `why_not` for the single operation asked about.
- Consequence: "the SDK cannot do X" is only answerable after a catalog query that returns nothing for X.
  That is the honesty contract, and G1 makes it a gate rather than a hope.

### 7.2 New checker rules

| ID | Rule | Fails when |
|---|---|---|
| **G1** | `catalog-reachability` | a registry operation has no catalog row, or has neither `tool` nor `reachable:false`+`reason`. Kills the 78-op hole and prevents a new one |
| **G2** | `catalog-op-exists` | a catalog row names an operation that is not a `CAPABILITY_REGISTRY` key, or an exposed `tool` that is not in the curated projection (both directions) |
| **G3** | `core-workflow-coverage` | CORE misses a read entry for any resource in `GROUPS.A`, or misses a cross-resource helper. Fails if coverage < 100 % of group A (measured today: 9/9) |
| **G4** | `schema-vocabulary-coverage` | the registry contains a `type`/key shape the invoke validator does not handle, or a handled shape has no unit test. This is the rule that keeps `hudu_invoke` sound |
| **G5** | `invoke-parity` | for any registry operation, `operations.invoke` with (a) an unknown name, (b) a missing required field, (c) an ill-typed field produces a different error code, or issues an HTTP request, than the typed method's pre-flight path. Request-free assertion mirrors the existing dry-run tests |
| **G6** | `core-budget` | the CORE `tools/list` payload exceeds its token budget (start at **8,000 tokens**, measured 6,294 → headroom, but bounded so it cannot creep back to 75k) |
| **G7** | `invoke-refusals-documented` | an operation refused by invoke (unbounded read, binary) is not catalogued with `reachable:false` + reason |
| **G8** (extension) | `check-example --profile` | the example registers a tool outside the profile, or the profile's declared tool set does not match the generated CORE list |

### 7.3 What breaks first in the existing gates

1. **`npm run mcp:project -- --check-example` — the first thing to break, and it will break loudly.**
   The gate recomputes the curated projection and fails on any registered tool name that is not a curated
   manifest tool (`scripts/project-mcp-tools.mjs`, `--check-example` block). `hudu_catalog`,
   `hudu_describe` and `hudu_invoke` are **not** in the projection, so the example fails on three unknown
   tool names the moment they are registered. It also fails if a core tool's description is not the curated
   one. Needed: either (i) record the three META tools as `MCP_TOOL_OVERRIDES.json` records with an explicit
   `kind: "meta"` (so the projection owns their descriptions, which is the discipline the repo already
   enforces), or (ii) add `--profile core` + a generated CORE list the gate accepts. (i) is smaller and keeps
   "curation is the only place a description changes" intact.
2. **`capabilities:check`** — `registry-orphan` / `emission-*` / `manifest-planhash` compare the registry, the
   generated `src/capabilities.ts` and the plan hash. Adding a generated `CATALOG` export and an
   `operations.invoke` dispatch means the generator and the planHash gate both move; any hand-edit of the
   catalog fails `manifest-planhash` (good — that is the point).
3. **`helper-*` rules** are unaffected: no helper is removed, no helper drops a bounded read, no
   `helperRationale` changes. The `resolution-caps` and `pagination` rules likewise still pass because invoke
   reuses the typed paths.
4. **Coverage rows**: G5's per-operation parity table adds 225 assertions; `status: tested` coverage is
   per-operation already, so the coverage gate gets *stronger*, not weaker. Nothing is removed from the gates.

### 7.4 `examples/mcp-server.ts`

- The 20-tool example becomes the **16-tool CORE profile + 3 META tools**: `hudu_get_company_context` … plus
  the three meta tools; the six company/article/asset tools it registers that fall outside the CORE rule
  (e.g. `hudu_find_companies_by_domain`, `hudu_search_users`) move to the *reachable-via-invoke* story, and
  the four write tools it registers (`create/update/archive/delete_company`, `delete_asset_password`) are
  demonstrated through `hudu_invoke` with `dry_run:true` — which keeps the existing "every mutating tool
  exposes dry-run" guarantee visible in the example, merely expressed once instead of 85 times.
- Its header comment "this file exposes the core tier (20)" must be rewritten: 20 tools become 16 + 3 meta,
  and the tier is now a generated list rather than a hand-picked set.
- `--check-example` must learn the META tools and the profile, or the example cannot be regenerated at all
  (§7.3.1).

---

## 8. Deltas vs the prior design documents

- `PROPOSAL.md` §11.2 (single self-describing search tool) is honoured: `hudu_search_knowledge` is in CORE and
  keeps its help mode. This document generalises the same move to the *whole* surface: the search tool is one
  instance of a discovery step that must exist for every operation, not only for search.
- The search proposal's 27 → 14 search-tool cleanup is subsumed: with CORE = 16 and the rest reachable via
  invoke, the "27 vs 14" decision loses most of its urgency, because the 13 extra search tools no longer cost
  anything on turns that do not use them. **Keep them out of CORE** either way.
- `MCP_TOOL_MANIFEST.md`'s claim that "tiering (core / extended) … is recorded in `MCP_TOOL_OVERRIDES.json`"
  is **not true today** (0 tier overrides measured). This design introduces the tier as a generated CORE list
  plus a profile flag, and the manifest note needs correcting.
- `PROPOSAL.md` §3's "980 KB / ~245k tokens" is corrected to the measured client payload (74,949 tokens).

---

## 9. Risks, named, with mitigations

| Risk | Honest size | Mitigation |
|---|---|---|
| **The agent does not know what it does not know** | Real and residual. A model that never calls `hudu_catalog` still concludes "not supported" | The catalog tool is always present and its own description states the total operation count and that the tool list is a subset; the core tool descriptions end with "if no tool fits, call `hudu_catalog`". G1 guarantees the catalog is complete, so a "no such capability" answer is at least *checkable*. No measurement exists for model behaviour here — the honest statement is that this is a prompting/description discipline, not a proof |
| **Extra round trips** | 1 extra call per capability in the common case; 2 when the schema is needed (catalog page 1,772 + describe 180 ≈ 2.0k tokens) | The alternative costs 68,527 tokens **every turn**. Break-even is one discovery per session. Deeper: `requires` in the catalog row lets a model invoke a simple write without a `describe` call |
| **Catalog drifts from the registry** | Would be fatal if hand-written | Catalog and describe are generator output with the plan hash embedded; G1/G2/G7 fail on any divergence; `manifest-planhash` already gates the same artifact |
| **`hudu_invoke` becomes a god tool** | Contained by construction: one operation per call, no chaining, exact-name lookup, and every guard the typed path has | Do not add scripting affordances (no multi-op arrays, no expressions). Keep CORE typed so the common path never goes through invoke. Blast radius = "an operation the SDK already exposes", never "anything the API can do" |
| **Loss of grounding for tool choice** | Real for the long tail, where the model picks from a 46-token row instead of a 500-token tool | `requires` + `when` + `effect` in the row; `hudu_describe` available before invoking; the CORE set keeps full descriptions for the common path. Explicitly rejected alternative: making everything a dispatcher (that maximises this risk) |
| **Schema vocabulary gap makes validation silently no-op** | The single most likely unsound outcome | G4: enumerate every shape in the registry, require a handler + a test per shape; treat an unknown shape as a hard failure, never as "accept" |
| **Tight context budget** | The 3-tool meta-only profile costs 124 tokens; the 40-row catalog page costs 1,772 | Profiles (`core` / `meta-only` / `extended`) as a host flag; catalog paging with a hard cap; describe is per-operation so it is never bulk |
| **Host-side dependence** | `tools/list` filtering and `list_changed` are the host's business | The design's core+meta path needs **no** host support beyond "register tools"; tier profiles and dynamic refresh are optional, and their absence must never make a capability unreachable |

---

## 10. Build order

1. **Catalog + describe generation** in the registry (`CATALOG` rows, describe builder) — pure generator work,
   with G1/G2 as checker rules and no behaviour change. Regenerate and confirm the manifest is untouched.
2. **`operations.invoke`** with the validator, G4 + G5, and unit tests mirroring the existing dry-run tests
   (assert: no HTTP request on an invalid input). This is the soundness-critical step; take it alone.
3. **META tools in the reference server** + the META override records, and the `--check-example` change
   (§7.3.1). This is the gate that will break first — do it in the same change as the example.
4. **CORE profile list** generated (G3, G6) and the example reduced to CORE + META; `HUDU_MCP_PROFILE` flag.
5. **Optional**: notification-based list refresh, once a host is tested (currently UNVERIFIED).

---

## 11. Evidence log, and what is UNVERIFIED

Commands run (repo root, branch `feat/agent-execution-layer`, no file under `src/`, `test/`, `scripts/`
touched, nothing committed):

| Claim | Command | Output |
|---|---|---|
| Manifest size | `wc -c MCP_TOOL_MANIFEST.md` | `981084` |
| Registry size, kinds, effects, resources | python over `capabilities.json` | 225 ops; `{primitive:158, helper:67}`; `{read:131, write:66, destructive:28}`; 36 resources |
| 78 ops unreachable | manifest `backingOperation` set vs registry keys | `registry ops not exposed as a tool: 78` |
| 147 tools / 74,949 tokens; field split; tier split; top-15 | `uv run --with tiktoken python /tmp/pd/measure.py` | see §1, §1.1 |
| Core-20 example cost | `/tmp/pd/v2.py` | 20 tools, 13,859 tokens (2,318 name+description) |
| CORE candidate costs | `/tmp/pd/v1.py` | reads-only 14/5,203; +create+update 30/17,127; +archive 34/17,781 |
| CORE (16) + catalog + describe sizes | `/tmp/pd/v5.py` | 6,294 tokens; catalog 10,161 all / 1,772 page-40, median row 46; describe median 180, max 753 |
| No tier overrides exist | `grep -c '"field": "tier"' MCP_TOOL_OVERRIDES.json` | `0` |
| Group A = workflow resources | `sed -n '70,110p' scripts/derive-plan.mjs` | `A: ['companies','articles','assets','asset_layouts','asset_passwords','websites','folders','password_folders','groups']` |
| `--check-example` semantics | `sed -n '/if (argv.includes(.--check-example.)),/…/' scripts/project-mcp-tools.mjs` | fails on a registered tool not in the curated manifest; "reference consumer, not the surface" |
| Checker rule vocabulary | `grep -o "fail('<rule>'" scripts/check-capabilities.mjs` | 44 distinct rules (no reachability/catalog rule exists) |
| Registry is already invocable-shaped | `grep -n 'getCapability\|CAPABILITY_NAMES' src/capabilities.ts` | `CAPABILITY_REGISTRY`, `CAPABILITY_NAMES`, `getCapability(name)` |
| Example registers 20 tools | `grep -n 'registerTool' examples/mcp-server.ts` | 20 registrations |

UNVERIFIED (stated as such, not assumed):

- Any **MCP host's** behaviour: per-session `tools/list` filtering, re-fetch on
  `notifications/tools/list_changed`, resource attachment UX, or prompt exposure. No host was run.
- The **exact token count a specific client charges**: measured with `cl100k_base` (a GPT-family tokenizer) as
  a portable proxy. Claude-family tokenizers differ by a few percent; the byte counts are exact.
- `hudu_search_knowledge`'s schema/description cost: not yet written (`PROPOSAL.md` §2 defines the input);
  ≈150 tokens by the median tool description.
- Whether the SDK's `listAll`/`listPages` accept a `maxRecords`-style bound: **not checked here**. The design
  therefore *refuses* them through invoke rather than inventing a bound option.
- That `operations.invoke` can dispatch all 225 operations without per-operation glue: the dispatch must be
  generated and asserted (G5); the SDK's `Operations` class was read only at its surface.
- No runtime or behavioural change was executed: no gate was run, no test was run, no live API call was made.
