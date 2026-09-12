# impl-D2 implement report — lists, label_types, labels, users (group D)

Run: `node-hudu-backfill-20260912` · branch `feat/agent-execution-layer` · impl-D2 (`sub-157bed59`)
Status: COMPLETE — including the `staleCheck` ruling AND the accepted-but-ignored option sweep.

## 1. Files changed

| Path | Lines | What |
|---|---|---|
| `src/resources/lists.ts` | 246 | `resolve` / `findByName` helpers; additive dry-run options on create/update/delete |
| `src/resources/label_types.ts` | 289 | `resolve` helper (compact `LabelTypeSummary`); additive dry-run options |
| `src/resources/labels.ts` | 313 | `resolve` (id / labelable pair) + `findByLabelable` (limit 25/100); additive dry-run options |
| `src/resources/users.ts` | 326 | `resolve`, `findByEmail`, `search` (compact `UserSummary`); read-only resource |
| `src/types/list.ts` | 32 | `ListIdentifier` (compact shape: none — the plan records `compact: null`) |
| `src/types/label_type.ts` | 49 | `LabelTypeIdentifier`, `LabelTypeSummary` |
| `src/types/label.ts` | 47 | `LabelIdentifier`, `LabelSummary` |
| `src/types/user.ts` | 65 | `UserIdentifier`, `UserSummary` |
| `test/resources/lists.test.ts` | 372 | 31 tests |
| `test/resources/label_types.test.ts` | 408 | 31 tests |
| `test/resources/labels.test.ts` | 412 | 35 tests |
| `test/resources/users.test.ts` | 422 | 33 tests |

Nothing outside those 12 paths was touched: no shared barrel (`src/types/index.ts`), no
generated file, no script, no plan row, no `base.ts`, no sibling resource. Never committed.

## 2. Commands run (exact) and exit codes — FINAL state

| # | Command | Exit |
|---|---|---|
| 1 | `npx tsc --noEmit` (project-wide) | **0** |
| 2 | `npx eslint src/resources/lists.ts src/resources/label_types.ts src/resources/labels.ts src/resources/users.ts src/types/list.ts src/types/label_type.ts src/types/label.ts src/types/user.ts test/resources/lists.test.ts test/resources/label_types.test.ts test/resources/labels.test.ts test/resources/users.test.ts` | **0** |
| 3 | `npx vitest run test/resources/lists.test.ts test/resources/label_types.test.ts test/resources/labels.test.ts test/resources/users.test.ts` | **0** — 4 files, **130 tests passed** |

(Scoped coverage, measured before the option sweep: 100 % lines/functions and 85–91 %
branches on my four resource files. No threshold was lowered, no test skipped, no
`--no-verify`; `npm test` / `capabilities:build` / `capabilities:check` are the
coordinator's batch gate and were NOT run.)

## 3. Honesty sweep — accepted-but-ignored options (the requested fix)

Every helper option bag now contains exactly the options the helper honours. Nothing else
changed: no helper name, parameter position, return shape or primitive was touched.

| Helper | Offered before | Honoured | Action |
|---|---|---|---|
| `users.search` | `limit, expand, resolutionDetails, archived, security_level` | all but `resolutionDetails` | **REMOVED `resolutionDetails`** (`UsersSearchOptions` no longer extends `HelperOptions`) — it returns an array, so a `Resolution<T>` wrapper is meaningless |
| `users.resolve`, `users.findByEmail` | `limit, expand, resolutionDetails` | `expand`, `resolutionDetails` | **REMOVED `limit`** (`UsersLookupOptions`) — each returns ONE record, and the scan page size comes from the client's bounded-scan config |
| `labels.resolve` | `limit, expand, resolutionDetails` | `expand`, `resolutionDetails` | **REMOVED `limit`** (`LabelsResolveOptions`) |
| `labels.findByLabelable` | `limit, expand, resolutionDetails` | `limit`, `expand` | **REMOVED `resolutionDetails`** (`LabelsFindByLabelableOptions`) — array-returning helper |
| `label_types.resolve` | `limit, expand, resolutionDetails` | `expand`, `resolutionDetails` | **REMOVED `limit`** (`LabelTypesResolveOptions`) |
| `lists.resolve`, `lists.findByName` | `limit, expand, resolutionDetails` | `resolutionDetails` | **REMOVED `limit`** (one record) **and `expand`** (`ListsHelperOptions`) — the plan records no compact shape for lists, so the default already returns the full record and `expand` changed nothing; the `{ expand: true }` overload was removed with it |

Regression guard added: each test file now carries an exact-key compile-time check
(`Record<keyof <HelperOptions>, true>`), so re-adding an option that nothing reads — or
dropping one that is honoured — fails `npx tsc --noEmit`. That is why the test count is
130 (124 + 6 guards: 1 lists, 1 label_types, 2 labels, 2 users).

## 4. Helper + mutation semantics (as implemented)

- `resolve` reads bare values in the order the plan's `usage` names (lists: id → name;
  label_types: id → slug → name; labels: id → labelable pair; users: id → email → slug →
  name). An explicit object is ONE stage and never falls through to another kind.
- `{ id }` / numeric bare value fetches directly; a 404 propagates as `NOT_FOUND` — never
  `null`. `null` only when every stage completed a scan (asserted, including "500 rows in
  one page is still not truncation" for non-paginated `/lists`).
- Every scan goes through `BaseResource.boundedScan` (500 records / 4 pages from client
  config) plus a bounded uniqueness pass with the first id excluded (`boundedScan` stops at
  the first match). Second match → `RESOLUTION_AMBIGUOUS` with both candidate ids in
  `resourceIds`; a uniqueness pass cut short by the cap → `RESOLUTION_TRUNCATED` via
  `BaseResource.requireResolved`, never `null`. Called out and accepted by the coordinator:
  a second bounded pass is only paid on the ambiguous path, and an id-only lookup pays one
  request.
- `findByLabelable` / `search`: exactly ONE page of `page_size = limit` (default 25, hard
  max 100 → `HuduConfigError`, also for non-integer / non-positive limits), sliced to
  `limit`. `findByLabelable` returns what the vendor pair filter returned; the exact compare
  belongs to `resolve`, which never treats a filter-ignoring server as a unique hit.
- `/lists` never receives `page`/`page_size` (asserted on every recorded call URL); all
  other scans carry `page_size=25`.
- **Mutations (post-ruling).** `create`/`update`/`delete` have an additive trailing options
  argument, so every existing call is unchanged; `dryRun: true` issues zero requests and
  returns `DryRunResult` with `simulated: true`. `expectedUpdatedAt` is honoured on
  **update only** (`staleCheck: "updated_at"` in the current plan, implemented by
  `BaseResource.updateOne`, mismatch → `STALE_OBJECT` before the PUT). On **create and
  delete the guard is `unavailable`**: passing `expectedUpdatedAt` is refused with
  `HuduConfigError` / `CONFIG_ERROR` / category `validation` and zero HTTP calls — never
  `STALE_OBJECT`, never silently ignored. `users` has no mutation paths.

## 5. Judgement calls, rulings, residual gaps

1. **create/delete `expectedUpdatedAt` — RULING APPLIED** (refusal kept, error switched to
   `HuduConfigError`, delete's read-then-compare removed, update untouched). One naming
   deviation, already flagged to the coordinator: the create/delete tests are titled
   `refuses expectedUpdatedAt on a create/delete with CONFIG_ERROR` rather than the old
   `… maps a mismatch to STALE_OBJECT`, because after the plan change that literal title
   would assert behaviour the code no longer has and those `.stale` rows were removed from
   the plan. The `update.stale` plan title is present verbatim and still asserts
   `STALE_OBJECT`.
2. **Generator `outputSchema.drops` bug — CONFIRMED by the coordinator, dispatched to the
   generator owner; nothing to change here.** My 6 affected rows (`label_types.resolve`,
   `labels.resolve`, `labels.findByLabelable`, `users.resolve`, `users.findByEmail`,
   `users.search`) are exactly the compact-returning helpers whose honest overload
   implementation signature is a union / array union. The compact shapes themselves are
   correct: parsing my interfaces yields drops `[allowed_company_ids, created_at,
   updated_at]` (LabelTypeSummary), `[created_at]` (LabelSummary) and the 12 fields in
   `.run/design/D.md` (UserSummary).
3. **`base.ts` `requireResolved(..., { identifier })` typing friction — CLOSED by ruling**
   (pass the scalar, which is what all four of my files do; recorded as a review-stage
   follow-up in SCOPING).
4. **Plan titles re-verified after the plan change:** all 25 rows I own, 25/25 current
   titles present verbatim in the file the row names, 0 missing. Every row's method is a
   public method of the right resource file.
5. **UNVERIFIED / not run (coordinator's batch gate):** `npm test` with the 97/94/83/97
   thresholds (scoped numbers above), `npm run capabilities:build`, `npm run
   capabilities:check -- --group D`. My rows stay `status: "planned"`; the generator fix
   gates the flip.
6. **OBSERVATION:** `src/resources/agent-layer-helpers.ts` (created mid-run by another
   implementer, exporting equivalents of my local limit / identifier-refusal / ambiguity
   helpers) exists. My four files stay self-contained per my brief and do NOT import it.
7. No network access anywhere: every test drives the shared `stubFetch` stub and asserts
   call counts and query strings.
