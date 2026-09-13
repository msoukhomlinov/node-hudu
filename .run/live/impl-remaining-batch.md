# Remaining-batch implementation: P1 (projection gate), P2 (failure isolation), P3 (`primary_serial`)

Run: `feat/agent-execution-layer`, working tree only (no commit, no branch switch, no push).
Verification tenant: Hudu 2.45.1 `hudu-sandbox.example.com` (throwaway key, passed in the environment; never written to a file).
Baseline after every live probe: **articles 16,17,18,19 intact; account-wide assets back to 20**.

Targets from the brief: P1 = make `prose-dangling-projection` shippable; P2 = per-resource failure isolation in
`operations.searchAcrossResources`; P3 = additive `{ primary_serial }` on `assets.search`; P4 = cheap items of the
unverified list. **P1, P2 and P3 shipped. P4 was dropped on budget** (see the boundary section).

---

## P1 — `prose-dangling-projection` is now a real gate (option (b) SCOPE + option (a) CLEANUP)

### Verdict, one line

Neither "clean everything" nor "drop the rule": the rule was **scoped to prose that reaches an MCP client** and,
inside that scope, the violating text was **cleaned**, so the gate ships green and fails on the very next violation.

### The drift, measured (not estimated)

Instrument: `/tmp/pd-probe.mjs`-family probes over `capabilities.json` + the curated projection
(`scripts/project-mcp-tools.mjs`) + the generated catalog, regex `\b([a-z_]+)\.[A-Za-z][A-Za-z0-9_]*\b` and
`\bhudu_[a-z0-9_]+\b` over `purpose`/`usage`/`preferredWhen` and the projection's own descriptions.

| surface | references that name something the projection does not expose | category |
|---|---|---|
| projection tool descriptions (`MCP_TOOL_MANIFEST.md`) | 22 unknown `hudu_*` tool names (+4 wildcard shapes) | `hudu_archive_<x>` for 20 resources with **no archive endpoint**, `hudu_update_magic_dash`, `hudu_update_relation` — invented tool names |
| same | 37 refs to **curated-out** operations (`articles.get`, `companies.list`, …) | reachable through `hudu_invoke` (`reachable: true, tool: null`) |
| same | 16 refs to **client-only** methods (`users.listAll`, `assets.listAllAcrossCompanies`, `expirations.get`) | no registry record: not a capability |
| plan + registry prose | 17 refs naming **refused** operations (photos/public_photos/uploads/exports siblings) | `reachable: false`: `hudu_invoke` refuses them too |
| plan + registry prose | 52 refs to curated-out operations | same as above (reachable via invoke) |
| plan + registry prose | 20 refs to client-only methods | same as above |

So the "48 sections name retired tools / 59 name absent tools" figure decomposes into exactly three classes, and
**only one of them is a lie to an agent**: a name that NO client can call (a refused operation) or a tool name that
does not exist. The others are (i) real, invoke-reachable capabilities whose *name* is not a tool name, or (ii) SDK
methods contrasted ("preferred over `users.listAll`") that were never capabilities.

### The rule as shipped

`prose-dangling-projection` (in `scripts/check-capabilities.mjs`, ~89 lines + header entry). Two surfaces, because
both are text an agent reads: (1) the curated projection's own tool descriptions (machine-readable block of
`MCP_TOOL_MANIFEST.md`), and (2) the plan rows' and registry records' prose fields, which the generated catalog
(`summary`/`when`) and `hudu_describe` republish. Verdicts:

* **FAIL** — a `hudu_*` name no projected tool has. A `_`/`<`/`*` shape (`hudu_get_<singular>`, `hudu_find_*`) is a
  PATTERN, not a name, and is skipped.
* **FAIL** — an operation the generated catalog REFUSES (`reachable: false`): `hudu_invoke` refuses it too, so no
  client can call it at all.
* **FAIL** — an operation neither the client nor the catalog knows. This is the gap the older rule left: the
  client-side `prose-dangling` scans plan + registry records only, so a description override's text is otherwise
  unchecked.
* **WARN** — an operation with no tool of its own (curated out as a duplicate outcome; reachable through
  `hudu_invoke`) — a real capability under a name that is not a tool name.
* **WARN** — a client method with no registry record at all (not a capability).

### Composition with `prose-dangling` (kept distinct, both stay)

| rule | question | scanned text | failure |
|---|---|---|---|
| `prose-dangling` | does the **CLIENT** have this method? | plan prose + registry prose | a name with no public method in `src/resources/*`, `src/operations/*` |
| `prose-dangling-projection` | can a **CLIENT** call this tool/operation? | the above **plus the projection's own descriptions** | a tool name that is not projected; an operation the catalog refuses; a name nothing knows |

A name can pass one and fail the other (an override-only bogus name passes `prose-dangling` and fails
`prose-dangling-projection`), so neither subsumes the other. They compose as two independent rules; the new one
reuses `sourceMethod()` so "does the client have it" has one answer, and reads the projection/catalog rather than
re-deriving the projection rules.

### Cleanup (option (a), inside the scope)

* `MCP_TOOL_OVERRIDES.json` — 25 sentences rewritten (20 × "`hudu_archive_<x>` keeps it" → the honest statement
  that Hudu carries archive paths only for articles, asset_passwords, assets and companies, verified against
  `api-docs.json`; plus `hudu_update_magic_dash` → the POST is an upsert over title/company_name;
  `hudu_update_relation` / `hudu_update_matcher` / `hudu_update_expiration` → the resource has no such endpoint,
  with the actual methods named; `expirations.get` mention removed, there is no such method).
  Diff: 25 insertions / 25 deletions.
* `capabilities.plan.json` — 16 prose strings rewritten (the 17 refused-operation refs, one string covering two):
  each now says the sibling form is **client-only** and that the resource backs no MCP tool. Diff: 16/16 lines.
* signal-to-noise: the 189 non-failing hits are now an **INFO count**, not warnings, because a name that is
  callable another way is not a lie — 135 refs to curated-out operations (callable through `hudu_invoke`) and 54
  to documented SDK methods with no registry record (162 passing mentions, 27 presented as call targets). The
  verdict is `mention`, decided by a CONTRAST-first classifier (a mention preceded by "over / rather than /
  instead of / not / never / avoid / without / versus / compared to" is informative prose; every contrast
  contains a directive verb, so contrasts are checked first) and it is never warned on.
* the remaining warnings are **66, all pre-existing `unplanned-surface`**, and the warning block is now grouped
  per rule: a COUNT plus the first 3 examples per rule, the full list under `--verbose`. Every FAIL is still one
  line per failure: failures are never grouped away. Warning count **255 → 66**; the summary line reads
  `warnings=66 info=189`.

### Injection proof (both FAIL classes)

1. Re-added `Do not use it to hide a record you may still need: hudu_archive_flag keeps it.` to a delete
   description → `npm run mcp:project` → checker **exit 1**:
   `✗ [prose-dangling-projection] MCP_TOOL_MANIFEST.md (hudu_delete_expiration): hudu_delete_expiration:
   description tells an agent to call the tool "hudu_archive_flag", which the curated projection does not expose —
   no client can select it`
2. Put `photos.get` into `assets.list`'s `preferredWhen` → `npm run capabilities:build` → checker **exit 1**:
   `✗ [prose-dangling-projection] capabilities.plan.json.metadata.preferredWhen: assets.list: preferredWhen names
   "photos.get", which no client can call — the generated catalog REFUSES it (binary/download surface …) and
   hudu_invoke refuses it too, so no MCP client can call it`
   (and the same failure on the emitted record, `CAPABILITY_REGISTRY['assets.list'].preferredWhen`).
Both were restored → checker **PASS — 0 failures; rows=227; warnings=255**.

Not in scope, stated plainly: `related[]` edges (checked by `related-dangling` against the registry, not against
the projection) and the design documents under `.run/design/**` (historical prose, not emitted text).

---

## P2 — per-resource failure isolation in `operations.searchAcrossResources`

**Shipped, additive.** A failing resource no longer has to decide what the other seven answered.

* `SearchAcrossResourcesOptions.isolateErrors?: boolean` (default `false`).
* New result shape `SearchAcrossResourcesResult<H = SearchHit>`: `{ hits, errors, failed, complete }`, with
  `SearchAcrossResourcesFailure = { resource, code, message }` — the same shape and vocabulary as the engine's
  `KnowledgeSearchError` ("a 5xx in one resource never loses the call"). `errors` is emitted in the documented
  fan-out order even though the fan-out completes out of order; `failed` is the same list under the plan's name;
  `complete` is true only when every requested resource answered.
* Two new overloads (`isolateErrors: true` × `expand: true|false`); the existing overloads are untouched, so no
  existing call site changes type or behaviour.
* `errorCode()` is now exported from `src/search/engine.ts` and reused, so the code vocabulary has one writer.

**Why isolation is opt-in.** A caller of the array form receives `SearchHit[]` and nothing else: if the default
silently skipped a failing source it could not be told, which is precisely the lie-by-omission the project forbids.
`isolateErrors: true` makes the skip impossible to miss; the default still rejects loudly. Making silence the
default would have traded one honesty defect for a worse one.

**Tests** (`test/operations.test.ts`, +6, all passing): one resource failing (7 still answer, `errors[0]` is that
resource with `SERVER_ERROR`); three failing (reported in fan-out order); all eight failing (`hits: []`,
`complete: false` — a total failure is never "no match"); nothing failing (`complete: true`); `expand: true`
carries the report and full records; and the default path still rejects with `SERVER_ERROR` for both the omitted
and the explicit `isolateErrors: false` form.

**Live boundary (honest):** NOT provoked live. The sandbox's transient 500s on `assets.listAcrossCompanies` are
not reproducible on demand, and the failing resource in these tests is the SDK's own retry-then-throw path, which a
mocked 5xx exercises exactly. The live side of P2 remains unverified.

---

## P3 — additive `{ primary_serial }` filter on `assets.search`

* `AssetSearchOptions.primary_serial?: string` (documented as the vendor `?primary_serial=` filter, an EXACT
  comparison; an empty string is ignored, matching the existing `company_id` handling), wired into the query
  filter; the registry picked the field up from the declaration on `npm run capabilities:build`
  (`opts.fields` = limit, expand, company_id, primary_serial).
* Plan row: `assets.search` gained test row `assets.search.serial`; its `usage` now names the filter (the text an
  agent reads).
* Unit test (exact title matching the plan row): `primary_serial=SER88N9X` and `search=SER88N9X` are both sent, and
  an empty value never reaches the vendor.

**Live proof (fixture created and deleted, inventory proven back):**

```
fixture 366 serial SER88N9X create status 200
SDK assets.search('zz-remaining-batch-probe', { primary_serial: 'SER88N9X' }) -> 1 hit(s): 366:zz-remaining-batch-probe
SDK assets.search('SER88') without the option -> 0
SDK assets.search(text, { primary_serial: 'SER88' }) -> 0   (exact match only, not a prefix)
delete status 204 | inventory after cleanup: 20 | fixture present? false
```

Two probes were used (365 for the raw-API form, 366 for the SDK form); both deleted, both proven gone, account-wide
assets back to 20.

**Other resources' search filters:** not audited. `asset_passwords.search` already exposes `company_id`; a full
audit of "a documented filter the helper should expose" was out of budget, so nothing else was changed — no
gold-plating, and no claim of completeness.

---

## P4 — dropped (budget), with the boundary stated

None of the four items was attempted:

* asset CUSTOM-FIELD snippets end to end (`field:<label>` path) — NOT DONE;
* the 4-byte/astral boundary in the index size cap — NOT DONE;
* CJK/accented folding — NOT DONE;
* whether the Hudu UI (Trix) preserves `<script>` like a direct API write — NOT DONE (needs a UI session; the API
  path stays as measured: script/style kept verbatim).

The live sandbox was used for P3 only, so its session budget went there.

---

## Gates (all green, after the final source state)

| gate | result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm test` | **58 files, 1845 tests passed** (was 1839; +6 isolation tests) |
| `node scripts/check-capabilities.mjs` | **PASS — 0 failures; rows=227 scoped=227 registryRecords=227 warnings=255** |
| `node scripts/check-capabilities.mjs --ship` | exit 0 |
| `MCP_PROFILE=core node scripts/project-mcp-tools.mjs --check-example` | OK (15 tools registered) |
| `node scripts/build-tool-catalog.mjs --check` | OK |
| `npm run test:coverage` | exit 0 — 97.84% statements / 91% branches / 99.46% functions / 99.13% lines against the configured 97/83/94/97 (statements/branches/functions/lines): every threshold met, none lowered |

Generated files were regenerated with the project's own scripts (`capabilities:build`, `mcp:project`,
`build-tool-catalog`); none was hand-edited.

## Files changed

`capabilities.plan.json`, `MCP_TOOL_OVERRIDES.json`, `scripts/check-capabilities.mjs`, `src/operations/types.ts`,
`src/operations/operations.ts`, `src/resources/assets.ts`, `src/search/engine.ts`, `test/operations.test.ts`,
`test/resources/assets.test.ts`; and regenerated by the project's scripts: `capabilities.json`,
`src/capabilities.ts`, `MCP_TOOL_MANIFEST.md`, `examples/tool-catalog.generated.ts` (14 files changed, untracked-none,
nothing committed).

Note: `.run/live/impl-search-engine-perf.json` shows as modified because the perf test rewrites it on every
`npm test` run — a pre-existing side effect, not an edit by this task.

## One trap found on the way (worth keeping)

The capability generator derives a helper's compact-shape `drops` from the **implementation signature's return
type text** and unwraps `Promise<...>` with `/^Promise<(.+)>$/`. A multi-line `Promise<
 | A[]
 | B[]...>` makes
that unwrap fail, so every helper row is emitted `dropsUnresolved: true` and `helper-compact-drops` fails. The
implementation signature of `searchAcrossResources` therefore stays on ONE line, with the reason recorded in the
source.
