# impl-D2 implement report — lists, label_types, labels, users (group D)

Run: `node-hudu-backfill-20260912` · branch `feat/agent-execution-layer` · impl-D2 (`sub-157bed59`)
Status: COMPLETE (incl. the coordinator's staleCheck ruling, applied and re-verified).

## 1. Files changed

| Path | Lines | What |
|---|---|---|
| `src/resources/lists.ts` | 234 | `resolve` / `findByName` helpers; additive dry-run options on create/update/delete |
| `src/resources/label_types.ts` | 280 | `resolve` helper (compact `LabelTypeSummary`); additive dry-run options |
| `src/resources/labels.ts` | 295 | `resolve` (id / labelable pair) + `findByLabelable` (limit 25/100); additive dry-run options |
| `src/resources/users.ts` | 309 | `resolve` (id / email / slug / name), `findByEmail`, `search`; read-only resource |
| `src/types/list.ts` | 32 | `ListIdentifier` (compact shape: none — the plan records `compact: null`) |
| `src/types/label_type.ts` | 49 | `LabelTypeIdentifier`, `LabelTypeSummary` |
| `src/types/label.ts` | 47 | `LabelIdentifier`, `LabelSummary` |
| `src/types/user.ts` | 65 | `UserIdentifier`, `UserSummary` |
| `test/resources/lists.test.ts` | 361 | 30 tests |
| `test/resources/label_types.test.ts` | 397 | 30 tests |
| `test/resources/labels.test.ts` | 397 | 33 tests |
| `test/resources/users.test.ts` | 402 | 31 tests |

Nothing outside those 12 paths was touched: no shared barrel (`src/types/index.ts`),
no generated file, no script, no plan row, no `base.ts`, no other resource. Six other
implementers wrote different resource files concurrently, so every command below is
scoped to my files.

## 2. Commands run (exact) and exit codes — FINAL state

| # | Command | Exit |
|---|---|---|
| 1 | `npx tsc --noEmit` (project-wide; run after the final edit) | **0** |
| 2 | `npx eslint src/resources/lists.ts src/resources/label_types.ts src/resources/labels.ts src/resources/users.ts src/types/list.ts src/types/label_type.ts src/types/label.ts src/types/user.ts test/resources/lists.test.ts test/resources/label_types.test.ts test/resources/labels.test.ts test/resources/users.test.ts` | **0** |
| 3 | `npx vitest run test/resources/lists.test.ts test/resources/label_types.test.ts test/resources/labels.test.ts test/resources/users.test.ts` | **0** — 4 files, **124 tests passed** |
| 4 | same as #3 + `--coverage --coverage.include=src/resources/{lists,label_types,labels,users}.ts --coverage.include='src/types/*.ts'` | 0 (project thresholds not applicable to a scoped run) |

Scoped coverage of my four resource files (final):

```
label_types.ts | 100 stmts | 87.5  branch | 100 funcs | 100 lines
labels.ts      | 100 stmts | 87.93 branch | 100 funcs | 100 lines
lists.ts       |  98 stmts | 85.29 branch | 100 funcs | 100 lines
users.ts       | 100 stmts | 91.01 branch | 100 funcs | 100 lines
```
(`lists.ts`'s 2 statement points are a v8 statement-map artifact on the module-level
identifier reader; its line coverage is 100 %.) No threshold lowered, no test skipped,
never `--no-verify`, `npm test` / bare `vitest run` deliberately NOT run (six partially
written sibling suites were in the tree).

## 3. Plan test titles — implemented (re-verified AFTER the plan change)

Every test row of all **25 rows I own**, in the CURRENT `capabilities.plan.json`, exists
verbatim (`it('<exact title>')`) in the file the row names: **25/25 rows, 0 missing.**
Nothing deferred. Verified with the checker's own token rule (raw literal title inside
`it(...)`) and, separately, that every row's method is a public method of the right
resource file.

- `lists.*` 7 rows / 30 tests · `label_types.*` 6 rows / 30 tests ·
  `labels.*` 6 rows / 33 tests · `users.*` 6 rows / 31 tests.
- Extra (my own truthful titles) beyond the plan rows: truncated-scan cases with asserted
  call counts (4 for a first-pass truncation, 7 when the uniqueness pass hits the cap),
  unsupported-identifier-kind refusals, `resolutionDetails` cost/shape, compact-vs-expand
  field loss, `streams the list and its pages`, and the CONFIG_ERROR refusals below.

## 4. Helper + mutation semantics (as implemented)

- `resolve` reads bare values in the order the plan's `usage` names (lists: id → name;
  label_types: id → slug → name; labels: id → labelable pair; users: id → email → slug →
  name). An explicit object is ONE stage and never falls through to another kind.
- `{ id }` / numeric bare value fetches directly; a 404 propagates as `NOT_FOUND` — never
  `null`. `null` is returned only when every stage completed a scan (asserted, including
  "500 rows in one page is still not truncation" for non-paginated `/lists`).
- Every scan goes through `BaseResource.boundedScan` (500 records / 4 pages from client
  config) plus a bounded uniqueness pass with the first id excluded (`boundedScan` stops at
  the first match). Second match → `RESOLUTION_AMBIGUOUS` with both candidate ids in
  `resourceIds`; a uniqueness pass cut short by the cap → `RESOLUTION_TRUNCATED` via
  `BaseResource.requireResolved`, never `null`. A unique name/slug/email lookup therefore
  costs 2 HTTP calls, paid only when the caller did not use `{ id }`.
- `findByLabelable` / `search`: exactly ONE page of `page_size = limit` (default 25, hard
  max 100 → `HuduConfigError`, also for non-integer / non-positive limits), sliced to
  `limit`. `findByLabelable` returns what the vendor pair filter returned; the exact
  compare belongs to `resolve`, which never treats a filter-ignoring server as a unique hit.
- `/lists` never receives `page`/`page_size` (asserted on every recorded call URL); all
  other scans carry `page_size=25`.
- **Mutations (post-ruling).** `create`/`update`/`delete` all gained an additive trailing
  options argument, so every existing call is unchanged. `dryRun: true` issues zero
  requests and returns `DryRunResult` with `simulated: true`.
  `expectedUpdatedAt` is honoured on **update only** (via `BaseResource.updateOne`, as the
  plan now records `staleCheck: "updated_at"` there); it maps a mismatch to `STALE_OBJECT`
  before the PUT. On **create and delete the guard is `unavailable`** (current plan):
  passing `expectedUpdatedAt` there is refused with **`HuduConfigError` / `CONFIG_ERROR` /
  category `validation` and zero HTTP calls** (never `STALE_OBJECT`, never silently
  ignored). No archive/unarchive path exists in my four resources.

## 5. Judgement calls, rulings and residual gaps

1. **create/delete `expectedUpdatedAt` — RULING APPLIED.** First steering said "do not add a
   stale guard to create/delete"; the follow-up ruling refined it to "keep your refusal,
   switch the code to `HuduConfigError`, keep your title". Applied: refusal kept, error
   switched to `HuduConfigError` (CONFIG_ERROR / validation), guard removed from delete's
   read-then-compare path, update untouched. **One naming deviation, flagged:** I renamed
   the create/delete tests to `refuses expectedUpdatedAt on a create/delete with
   CONFIG_ERROR` instead of keeping the old title
   `sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT`, because after
   the plan change that title would assert a behaviour (STALE_OBJECT) the code no longer
   has, and those `.stale` rows were removed from the plan (so nothing requires that exact
   title). The `update.stale` title from the plan is present verbatim and its body still
   asserts STALE_OBJECT. Say the word and I will restore the old literal titles.
2. **Generator `outputSchema.drops` bug — CONFIRMED, dispatched, nothing for me to change.**
   `scripts/generate-capabilities.mjs::outputSchema` derives `drops` from
   `resolveProps(<last method declaration>.returnType)`; for an honest overloaded helper
   that is a union (`Label | LabelSummary | null | Resolution<LabelSummary>`) or array
   union (`Label[] | LabelSummary[]`), which `resolveProps` cannot resolve →
   `dropsUnresolved: true` → `drops: []` → `helper-compact-drops` fails for every
   compact-returning helper. My 6 affected rows: `label_types.resolve`, `labels.resolve`,
   `labels.findByLabelable`, `users.resolve`, `users.findByEmail`, `users.search`.
   The compact shapes themselves are correct — parsing my interfaces yields drops
   `[allowed_company_ids, created_at, updated_at]` (LabelTypeSummary), `[created_at]`
   (LabelSummary) and the 12 fields in `.run/design/D.md` (UserSummary).
3. **`base.ts` `requireResolved(..., { identifier })` typing friction — CLOSED by ruling.**
   `Identifier`/`IdentifierObject` requires an index signature, so resource-specific
   identifier interfaces are TS2322 there; I pass the scalar (`ref.id ?? ref.name`), which
   the coordinator confirmed is the supported call. No base.ts change mid-flight.
4. **UNVERIFIED / not run (coordinator's batch gate):** `npm test` and the project
   thresholds 97/94/83/97 (scoped numbers are in §2); `npm run capabilities:build` and
   `npm run capabilities:check -- --group D` (both touch shared generated files). My rows
   stay `status: "planned"` — flipping to implemented/tested and emitting the registry is
   the coordinator's step, and the generator fix gates it.
5. **OBSERVATION:** `src/resources/agent-layer-helpers.ts` (created mid-run by another
   implementer, exporting equivalents of my local limit/identifier/ambiguity helpers)
   exists. My four files stay self-contained per my brief and do NOT import it;
   consolidation is a batch-gate decision.
6. No network access anywhere: every test drives the shared `stubFetch` stub and asserts
   call counts and query strings.
