# Tooling scripts report — capability registry, checker, MCP projection

Agent: tooling-scripts (child of the node-hudu agent-execution-layer coordinator)
Repo: /Users/maxs/gitrepos/node-hudu, branch feat/agent-execution-layer
Date: 2026-09-12. Plan of record at report time: capabilities.plan.json, sha256
`b484cff113baf950e08119c33107f1bace80c6b1df26c117d03a65d6ae046e9b`, 223 rows (158 primitive-implemented + 65 planned helper rows).

No git commit / push / publish / install was run. Nothing owned by another writer was modified
(`src/index.ts` untouched, `capabilities.plan.json` and `scripts/derive-plan.mjs` untouched,
`scripts/plan:derive` never run, test/** untouched except the one new fixture file).

## 1. Files written

| Path | Lines | Bytes | Role |
| --- | --- | --- | --- |
| `scripts/generate-capabilities.mjs` | 586 | 26,296 | `npm run capabilities:build` |
| `scripts/check-capabilities.mjs` | 404 | 14,185 | `npm run capabilities:check` (the gate) |
| `scripts/project-mcp-tools.mjs` | 255 | ~12 KB | `npm run mcp:project` |
| `test/fixtures/capabilities.plan.drifted.json` | 12,965 | 421,111 | negative fixture (real derived copy of the plan + 3 deliberate drifts + `_fixture` marker) |
| `src/capabilities.ts` (generated) | 212 | 286,365 | runtime registry, 158 records, zero imports |
| `capabilities.json` (generated) | 170 | 281,540 | machine-readable emission + planHash |
| `capabilities.schema.json` (generated) | 170 | 3,690 | JSON Schema for the emission |
| `MCP_TOOL_MANIFEST.md` (generated, repo root) | 1,538 | ~419 KB | mechanical MCP projection, 141 tools |

Edits (the two allowed small ones, both applied with exact-string replacement):
- `tsup.config.ts`: entry list gains `'src/capabilities.ts'`.
- `package.json`: `exports` gains `"./capabilities"` (import+require, types+default) mirroring `"./errors"`.
  The `"scripts"` block was NOT touched; it already contains `plan:derive`, `capabilities:build`,
  `capabilities:check`, `mcp:project` — confirmed by reading it, not edited.

Design notes: both scripts are Node ESM, import `typescript` only for AST work (devDep, allowed),
add no runtime dependency, and never write a judgement column. The generator copies
`helper/helperBasis/helperRationale/flags/metadata/compact/resolution/staleCheck/redaction` from
the plan and tolerates `null` everywhere.

## 2. Commands run: exact exit codes and first/last output lines

| # | Command | Exit | First line | Last line |
| --- | --- | --- | --- | --- |
| 1 | `node scripts/generate-capabilities.mjs` | **0** | `capabilities:build — plan capabilities.plan.json planHash=b484cff1...046e9b` | `  - users.search (operations[222]) not emitted: status="planned" — coverage gap, no registry record` (69 lines; 158 records emitted, 65 coverage gaps, 0 warnings) |
| 2 | `npm run capabilities:build` | **0** | same as #1 | same as #1 |
| 3 | `npx tsc --noEmit` | **0** | (no output) | (no output) |
| 4 | `node scripts/check-capabilities.mjs` | **1** | `capabilities:check — plan capabilities.plan.json planHash=b484cff1...; rows=223; scoped=223; scope=all groups (planned tolerated)` | `FAIL — 1 failure(s) in 1 distinct rule(s): impact-bound=1` |
| 5 | `node scripts/check-capabilities.mjs --group A` | **1** | `... scoped=77; scope=batch gate, group A` | `FAIL — 25 failure(s) in 1 distinct rule(s): batch-status=25` |
| 6 | `node scripts/check-capabilities.mjs --ship` | **1** | `... scoped=223; scope=ship gate (all groups, every row tested)` | `FAIL — 224 failure(s) in 2 distinct rule(s): ship-status=223, impact-bound=1` |
| 7 | `npm run capabilities:check -- --ship` | **1** | (npm passthrough works) | `FAIL — 224 failure(s) ... ship-status=223, impact-bound=1` |
| 8 | `node scripts/check-capabilities.mjs --plan test/fixtures/capabilities.plan.drifted.json` | **1** | `capabilities:check — --plan test/fixtures/capabilities.plan.drifted.json: emission rules (planHash comparison, emitted-file presence) are SKIPPED by design so a fixture can exercise the other rules.` | `FAIL — 4 failure(s) in 4 distinct rule(s): missing-key=1, mutation-dryRun=1, test-title=1, impact-bound=1` |
| 9 | `node scripts/project-mcp-tools.mjs` | **0** | `mcp:project — registry capabilities.json planHash=b484cff1...; records=158` | `mcp:project — read tools missing helper-tier backing: 56 (...)` |
| 10 | `npm run build` | **0** | tsup DTS list | `dist/capabilities.{js,cjs,map,d.ts,d.cts}` produced (js 313,867 B; d.ts 604,543 B) |
| 11 | `node --input-type=module -e "import {CAPABILITY_NAMES,getCapability} from 'node-hudu/capabilities'; ..."` | **0** | `names 158` | `keys 158` (subpath resolves; `purpose` = "Retrieve a specific company." — no side effects) |
| 12 | `npm test -- --coverage` | **0** | `Test Files  15 passed (15)` | `Tests  379 passed (379)`; `All files 97.07 stmts / 77.37 branch / 96.56 funcs / 96.9 lines`, `capabilities.ts 0%` |
| 13 | `npm run lint` | **0** | `> eslint src test` | (no findings, including the generated `src/capabilities.ts`) |
| 14 | override path, run in `/tmp/ovtest` with a temp `MCP_TOOL_OVERRIDES.json` | **0** then **1** | `... overrides applied=1` + `| hudu_companies_get | description | "Fetch one company by numeric id." | verification |` | unknown-tool override → `mcp:project — UNRESOLVED OVERRIDES (1) ... ✗ ...: no projected tool named "hudu_no_such_tool"` |
| 15 | compact-drops path: generator run with `--plan /tmp/compact.plan.json --out /tmp/compactout --no-src` (synthetic row: `companies.get` + `compact: "CompanySummary"`) | **0** | — | `outputSchema` = `{"type":"CompanySummary","drops":[21 fields...],"dropsUnresolved":false,"fields":[7 fields],"expand":"true returns the full typed record"}` |

## 3. Discrepancy vs the coordinator's predicted outcomes

The coordinator predicted `node scripts/check-capabilities.mjs` PASS and `--group A` PASS, and
`--ship` FAIL. Observed: default **FAIL(1)**, `--group A` **FAIL(25)**, `--ship` **FAIL(224)**.

- Default FAIL — one row only: `operations[168] magic_dash.deleteById` is `destructive` and
  declares no dry-run test row, so no impact bound is recorded (policy §4.2 safety completeness,
  §7.3 bounded mutations). Fix is one plan edit: add a `magic_dash.deleteById.dry-run` test row
  (id or title containing "dry-run"). 93 of 94 mutations pass.
- `--group A` FAIL — 25 `batch-status` failures: the 25 helper rows now in group A are all
  `status:"planned"`. The batch gate requires `implemented|tested` for the group's rows. This is
  the Design→Resources transition, not a script defect.
- `--ship` FAIL — as predicted: 223 `ship-status` (no row is `tested`) + the same `impact-bound`.
- Earlier in the session the default run also failed 36 `staleCheck` rules (mutations with
  `staleCheck: null`). The coordinator filled that column while I worked; those failures are gone.
- If the coordinator wants the default run to PASS before the helper batches, the helper rows need
  `status:"implemented"` (plus the methods) or the batch rules need an explicit scope change —
  that is a policy decision, so I did not weaken the rule.

## 4. Failures I hit and fixed while building

1. checker could not read `CAPABILITY_REGISTRY` — the generated `as const satisfies Record<...>`
   wrapper hid the object literal from the AST walk. Fixed by unwrapping
   `SatisfiesExpression`/`AsExpression`/`ParenthesizedExpression`.
2. generator emitted `inputSchema: {data: {type:"object", typeName:"CompanyCreate", resolved:false}}`
   for `Partial<Omit<Company, ...>>` params. Fixed with a resolver for `Partial`/`Required`/`Omit`/`Pick`
   and wrapped aliases. Remaining unresolved inputs (4): `exports.list`, `public_photos.list`,
   `s3_exports.create`, `uploads.list` (their param types are not declared in `src/types`).
3. first fixture run failed with ENOENT because `/tmp/compactout` did not exist — the generator now
   `mkdir -p`s the `--out` directory.
4. A `python` delete of a temporary root-level `MCP_TOOL_OVERRIDES.json` was blocked by the safety
   guard (`python-delete-outside`) and the whole cell did not execute. I did not retry; the
   overrides path was verified in `/tmp/ovtest` instead. `MCP_TOOL_OVERRIDES.json` does not exist in
   the repo (checked with `ls`); no override was invented or curated.

## 5. Open items and recommendations (coordinator decisions, not made by me)

1. **Coverage interaction (important).** `vitest.config.ts` has `coverage.include: ['src/**/*.ts']`,
   so the generated `src/capabilities.ts` is measured and reports 0%. Measured effect:
   with it: lines 96.9 / stmts 97.07 / funcs 96.56 / branch 77.37;
   with `--coverage.exclude=src/capabilities.ts`: lines 97.62 / stmts 97.75 / funcs 96.83 / branch 77.37.
   So the file pushes `lines` below the never-lowered 97 threshold (the current run still exits 0 —
   branch 77.37 was already below 83, so the top-level threshold keys are evidently not enforced by
   this vitest version/config). Recommendation: add `src/capabilities.ts` to `coverage.exclude`
   (machine-generated data, same class as `src/types/**`) or add one registry test. I did not touch
   `vitest.config.ts` — it is not mine.
2. **Registry size.** `src/capabilities.ts` 286 KB, `dist/capabilities.js` 314 KB, d.ts 604 KB. The
   full `outputSchema.fields` lists dominate. If that is too heavy for the published package, the
   emitter can omit `fields` behind a flag — your call.
3. `magic_dash.deleteById` needs its dry-run test row (see §3).
4. Helper records: 65 helper rows exist, all `planned`, and no helper method exists in
   `src/resources/*.ts` yet, so the registry emits no helper record and reports each as a coverage
   gap ("helper planned but not implemented"), exactly as briefed. `src/operations/` does not exist
   yet, so cross-resource helper resolution is UNVERIFIED.
5. `preferredWhen` sibling rule is mechanical: same resource + same normalised endpoint. Curated
   near-duplicates that do not share an endpoint (`findByDomain` vs `list`) cannot be detected
   mechanically — documented in the script header; no such failure fires today.
6. `impact-bound` and `dryrun-shape` use the documented proxy "the row declares a dry-run test row",
   because the plan has no impact column and the dry-run result shape is asserted in tests.
7. MCP: 141 tools projected; per the brief the script prints the helper-tier gap (56 read tools with
   no helper backing) and lists curation still owed (names, bound/tier statements, token budget).
   It never re-derives a description: descriptions are `registry.purpose` verbatim, overridable only
   through `MCP_TOOL_OVERRIDES.json`.

## 6. UNVERIFIED

- MCP manifest consumed by a real MCP client: not run (no server code in this repo); the projection
  is unvalidated against `@modelcontextprotocol/server`.
- `group: "operations"` / cross-resource helpers in `src/operations/*.ts`: no such file exists yet.
- Repo-root `MCP_TOOL_OVERRIDES.json` application: no such file exists; verified on an identical code
  path in `/tmp/ovtest` only.
- Test-title matching for titles built with interpolated template literals: the regex captures the
  raw literal text only, so such a title would be reported as missing.
- Helper rows at `status:"tested"` → record emission and the `helper-compact-drops` rule for a
  *helper* record: no helper method exists yet. The compact `drops` derivation itself is verified on
  the identical code branch (a synthetic primitive row carrying `compact`, command #15).
- The `--group B|C|D` runs: only `--group A` was exercised.

## 7. Addendum — pagination mode fix (coordinator follow-up)

Finding (from `test/registry.test.ts`): non-paginated list endpoints emitted
`{"mode":"page","defaultPageSize":25,"nonPaginated":true}` — internally contradictory.

Fix in `scripts/generate-capabilities.mjs::paginationFor`: `nonPaginated` is now derived as
`sourceSays === false || (sourceSays === null && specSays)`, and then
- `nonPaginated === true`  → `{mode:"none", defaultPageSize:null, maxPageSize:null, nonPaginated:true, ...cross-check}`
- `nonPaginated === false` → `{mode:"page", defaultPageSize:<DEFAULT_PAGE_SIZE from src/config.ts>, maxPageSize:null, ...}`
- non-list primitives keep `{mode:"none", defaultPageSize:null, maxPageSize:null, nonPaginated:true}`.

Re-ran, in order, after the fix (plan hash at that moment `807b5598726e9fe7acb4e1451dec5e21984483a88e01fca96cd427d11d108bb1`):
- `node scripts/generate-capabilities.mjs` EXIT 0
- `node scripts/check-capabilities.mjs` EXIT 0 — `PASS — 0 failures; rows=223 scoped=223 registryRecords=158 warnings=66`
- `npx vitest run test/registry.test.ts` EXIT 0 — `Test Files 1 passed (1)`, `Tests 8 passed (8)`
- `npx tsc --noEmit` EXIT 0 (no output)
- `node scripts/project-mcp-tools.mjs` EXIT 0 (manifest regenerated against the new registry)

Spot-check of the emitted pagination: `exports.list` and `vlans.list` → `mode "none"`, both
page-size fields null, `nonPaginated true`; `companies.list` → `mode "page"`, `defaultPageSize 25`,
`maxPageSize null`; `companies.get` → `mode "none"`.

`test/registry.test.ts` and `capabilities.plan.json` were not touched. Nothing committed.

## 8. Addendum — overload-union drops fix (coordinator follow-up, blocking)

Bug: `outputSchema()` derived `drops` from `resolveProps(<last method declaration>.returnType)`.
The mandated helper pattern is an overload set whose implementation signature must return the
union of the public returns (TS 2394 forbids a narrower implementation return type), e.g.
`Company | CompanySummary | null | Resolution<CompanySummary>`. `resolveProps()` cannot resolve a
union text, so every compact-returning helper would have emitted
`{ drops: [], dropsUnresolved: true }` and failed the `helper-compact-drops` rule.

Fix in `scripts/generate-capabilities.mjs`:
- new `splitTopLevel()` splits a union on TOP-LEVEL `|` only (nested `<>`, `()`, `[]`, `{}` respected,
  so `Resolution<A | B>` stays one member);
- new `pickFullMember()` skips `null`/`undefined`/`void` and `Resolution<...>` members, unwraps `X[]`
  and `Array<X>`, resolves the remaining members, and picks the tightest STRICT superset of the
  compact shape's fields (excluding a member that IS the compact type). If only one member resolves,
  it is used; if only the compact shape itself resolves, `drops: []` is emitted — the honest answer
  when the compact shape keeps every field. `dropsUnresolved: true` is now emitted only when no
  member resolves, so the checker still fails loudly instead of the registry lying.
- `drops` still equals (fields of the full record type) minus (fields of the compact shape).
- build stdout now prints `records with dropsUnresolved=true: N`.

Checker (`scripts/check-capabilities.mjs`), `helper-compact-drops` rule tightened:
fails when a record declares a `compact` shape and either `dropsUnresolved === true` or `drops` is
not an array; also fails when `compact` is null but the record carries a drops claim. An empty
`drops` array is valid.

Verification (plan untouched; synthetic plan in /tmp with all 65 helper rows set to implemented):
- `node scripts/generate-capabilities.mjs --plan /tmp/helpers.plan.json --out /tmp/dropout --no-src`
  EXIT 0 — `records emitted=223`, **`records with dropsUnresolved=true: 0`**, `coverage gaps: none`.
- samples: `relations.resolve` → fullType `Relation`, drops 2; `companies.resolve`/`findByDomain` →
  `Company`, drops 15; `users.findByEmail` → `User`, drops 12; `vlans.resolve` → `Vlan`, drops 4;
  the three `getContext` helpers → `drops: []` (compact keeps every field of the `*ContextExpand` type);
  the 7 helpers with `compact: null` carry no drops claim.
- checker with that synthetic plan + a temp registry (`--registry /tmp/temp-registry.ts`):
  `PASS — 0 failures; rows=223 scoped=223 registryRecords=223`.
- negative control (one record in the temp registry forced to `dropsUnresolved: true`):
  EXIT 1, `FAIL — 1 failure(s) in 1 distinct rule(s): helper-compact-drops=1`.

Real-plan re-run (planHash 6808b158074e049e...): build EXIT 0 (`dropsUnresolved=true: 0` — the real
plan still has all helper rows `planned`, so no helper record is emitted yet); checker EXIT 0
`PASS — 0 failures; rows=223 scoped=223 registryRecords=158 warnings=66`; `npx tsc --noEmit` EXIT 0;
`npx vitest run test/registry.test.ts` EXIT 0 `Tests 8 passed (8)`. `MCP_TOOL_MANIFEST.md`
regenerated against the new registry.

## 9. Addendum — QA findings 1-3 (inputSchema opacity, stale-manifest gate, tier statements)

**FINDING 1 — opaque generated inputSchema (fixed).** Root cause was shared with the drops bug:
the registry read only the LAST method declaration. For an overloaded helper the implementation
signature takes a bag (`opts?: HelperOptions`) or a narrowed type, and several shapes were not
resolvable at all: intersections (`HelperOptions & { company_id?: number }`), interfaces with
`extends` (`UsersSearchOptions extends HelperOptions`), named aliases that ARE unions
(`Identifier = number | string | {...}`), free-form bags (`S3ExportCreate = Record<string, unknown>`),
literal-typed members (`{ expand: true }`), and `src/pagination.ts` (`ListParams`), which was not
parsed at all. Multi-parameter methods were also flattened, which merged `from`/`to`.

Generator changes:
- every method declaration is indexed (`decls`), not only the last; `paramInfo()` per position takes
  the declaration whose parameter resolves to the MOST fields, preferring the later declaration on a
  tie (the implementation advertises the wide type, an overload the narrowed literal);
- `resolveProps()` now handles top-level intersections (inline literal parts parsed directly),
  `interface X extends Base` (inherited fields merged), named aliases whose body is a union
  (first resolvable member), and `Record<K,V>` free-form bags;
- `jsonType()` now recurses into named alias bodies, keeps union members in `variants` with their
  fields, and maps `true`/`false` literal types to `{type:"boolean", enum:[...]}`;
- multi-parameter inputSchemas keep the parameter names and nest each object parameter's fields
  (single-parameter methods stay flattened, e.g. `companies.create`);
- inline type literals no longer print a bogus `typeName`;
- the build prints `records with an opaque inputSchema (type name, no fields): N` plus the names.

Result: **opaque inputSchemas 30 → 0**; no helper record contains a bare opaque `opts`.
Samples: `articles.search` → `query` + `opts{limit,expand,company_id}`; `assets.search` /
`asset_passwords.search` → `opts{limit,expand,resolutionDetails,company_id}`; `users.search` →
`opts{limit,expand,resolutionDetails,archived,security_level}`; `cards.resolve` / `matchers.resolve` →
`identifier` union with the object variant's fields + `opts{limit,expand,resolutionDetails,allowClientScan}`;
`relations.findByEndpoints` → `from{type,id}`, `to{type,id}`, `opts{...}`.

**FINDING 2 — the stale manifest was ungated (fixed).** `check-capabilities.mjs` gains the
`manifest-planhash` rule (it fails when `MCP_TOOL_MANIFEST.md` is absent, carries no planHash, pins
a different planHash, or states a record count that disagrees with the registry). New `--manifest
<path>` flag for direct testing. Verified with two drifted copies in /tmp: wrong hash → EXIT 1
(`manifest-planhash=1`), wrong count (158 claimed vs 223 actual) → EXIT 1. The projection was
re-run so the manifest matches the registry.

**FINDING 3 — tier statements (fixed).** Every projected tool now states its tier and its
helper-tier backing: helper-tier tools carry `helperTierBacking`, primitive read tools carry
`helperTierAlternatives` (the registry's helper-tier ops for the same resource) and are listed under
a `WARNING — read tools still backed by a plain primitive` section (the Phase-2 worklist);
`listAll`/`listPages` are still never projected. Console now prints the same warning count.

Commands after the fixes (planHash `2f6e6b2f9089a4eb014abd9eb5b63841e262966bb2c6843d741cc032a5b5fd7c`,
plan 225 rows / 223 emitted):
- `node scripts/generate-capabilities.mjs` EXIT 0 — `records emitted=223`, `opaque inputSchema: 0`, `dropsUnresolved=true: 0`
- `node scripts/project-mcp-tools.mjs` EXIT 0 — `records=223`, `tools projected=201; excluded=22`, `WARNING: 57 read tool(s) still backed by a plain primitive`
- `node scripts/check-capabilities.mjs` EXIT 0 — `PASS — 0 failures; rows=225 scoped=225 registryRecords=223 warnings=66`
- `node scripts/check-capabilities.mjs --ship` EXIT 1 — `FAIL — 2 failure(s) in 1 distinct rule(s): ship-status=2` (the two `operations.*` rows, expected)
- `npx tsc --noEmit` EXIT 0 (no output); `npx vitest run test/registry.test.ts` EXIT 0 — `Tests 8 passed (8)`
- fixture still fails as designed: `--plan test/fixtures/capabilities.plan.drifted.json` EXIT 1, 4 distinct rules

**Caveat:** two agents are still editing `src/resources/*.ts`. Any registry change makes the manifest
stale again, and the new `manifest-planhash` rule now catches it — run `npm run mcp:project` after
those edits land (the projection is deliberately not part of `capabilities:build`).

## 10. Addendum — consolidated follow-up (example safety, 9 new gate rules, injections)

**CRITICAL — examples documented throwing calls (fixed).** `BaseResource.assertNoExpectedUpdatedAt`
runs before the dry-run branch, so a create/delete/archive example passing `expectedUpdatedAt` raises
`HuduConfigError` and never reaches the wire. `exampleFor()` now emits `{ dryRun: true }` for every
mutation options bag, and `expectedUpdatedAt` only on a row that is both `<x>.update` **and**
`staleCheck === "updated_at"`. New checker rule `example-expectedUpdatedAt` enforces it.
Count before: 75 records with `expectedUpdatedAt`, 51 of them non-update. After: **25 records, 0
non-update**. Samples now: `companies.create(..., { dryRun: true })`, `companies.delete(1, { dryRun: true })`,
`companies.update(1, {...}, { dryRun: true, expectedUpdatedAt: '2026-01-01T00:00:00Z' })`.

**New gate rules** (all in `scripts/check-capabilities.mjs`, all forced to fail by an injection):
`example-expectedUpdatedAt`, `preferredWhen-required` (every row of a resource that has a helper must
record preferredWhen; the old same-endpoint sibling rule is kept), `compact-shape-unknown` (a compact
name must be an exported interface/type in `src/types/**` or `src/operations/**`),
`resolution-caps` (client-scan needs both caps > 0; server-filter must still declare them; an
unknown basis such as `composite` is a warning, since composition is not a scan),
`redaction-value` (exactly "none" | "credentials"),
`errors-vocabulary` (SCREAMING_SNAKE; CONFIG_ERROR on every row; STALE_OBJECT when staleCheck is
updated_at), `related-dangling` (every related entry must be a registry record — this pins the 79
edges the coordinator repaired), `pagination` (object present; never nonPaginated + mode "page"; a
list primitive states its mode; a paginated record needs a positive `maxPageSize`), and
`inputSchema-name` (every field object carries the `name` key `CapabilityField` declares).

**maxPageSize is now a real bound.** The generator reads the vendor's `page_size` parameter
description in `api-docs.json` (`max(?:imum)?\s*(\d+)`) and falls back to the MCP bound 100:
`groups.list` → 1000 (`maxPageSizeSource: "api-docs"`), `companies.list` → 100 (`"default"`).
Non-paginated list records stay `mode: "none"` with null sizes.

**Field `name` coverage.** Every inputSchema field node — parameter nodes, nested `fields[]` entries
and union `variants` — now carries its `name`, so `CapabilityField` is honest. Injection I11 (a field
node without `name`) fails with `inputSchema-name`.

**Injection battery** (each on a /tmp copy; `check-capabilities.mjs` exit code — all 1):

| # | injection | exit | rule that fired |
| --- | --- | --- | --- |
| I1 | non-update example passes expectedUpdatedAt | 1 | example-expectedUpdatedAt |
| I2 | preferredWhen blanked on all rows | 1 | preferredWhen-required |
| I3 | compact = "NotARealShape" | 1 | compact-shape-unknown |
| I4 | caps stripped from 5 client-scan rows | 1 | resolution-caps |
| I5 | pagination mode "page" + nonPaginated true | 1 | pagination |
| I6 | list primitive without a pagination object | 1 | pagination |
| I7 | error code `not_screaming` | 1 | errors-vocabulary |
| I8 | CONFIG_ERROR removed | 1 | errors-vocabulary |
| I9 | redaction = "sometimes" | 1 | redaction-value |
| I10 | related = ["ghost.operation"] | 1 | related-dangling |
| I11 | inputSchema field without `name` | 1 | inputSchema-name |
| I12 | committed fixture | 1 | missing-key, mutation-dryRun, test-title (3 by design) |

**Fixture re-derived** from the current plan with the same three deliberate drifts (the earlier copy
had accumulated incidental drift and fired extra rules). It now fails exactly the three intended
rules, non-zero as required.

**Final battery** (planHash `defc10c664e04404210cfcdef4a2bc307e6c3e86b9e2b09c67a841a816977b53`, manifest
pinned to the same hash, 225 rows / 223 records):
`generate-capabilities.mjs` EXIT 0 (`records emitted=223`, `opaque inputSchema: 0`, `dropsUnresolved: 0`);
`project-mcp-tools.mjs` EXIT 0 (`tools projected=201; excluded=22`, 57 primitive-backed read warnings);
`check-capabilities.mjs` EXIT 0 (`PASS — 0 failures; registryRecords=223 warnings=67`);
`npx tsc --noEmit` EXIT 0; `npx vitest run test/registry.test.ts` EXIT 0 (`Tests 8 passed (8)`);
fixture EXIT 1 (3 rules by design); `--ship` EXIT 1 (`ship-status=2` — the two `operations.*` rows,
expected and deliberately not "fixed").
