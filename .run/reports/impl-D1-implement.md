# impl-D1 — Group D resources: uploads, photos, public_photos, exports, s3_exports

Status: **implementation complete, own tests GREEN, no tsc/eslint errors in my files.**
Coordinator ruling of 2026-09-12 applied (see "Ruling applied" below). No commit, no push.

## Files changed (line counts: added / removed vs `HEAD`; new files = total lines)

| File | Change | Lines |
|---|---|---|
| `src/resources/uploads.ts` | `resolve`, `upload`/`delete` dry-run + guard refusal, audit ops | +194 / -7 |
| `src/resources/photos.ts` | `resolve` (id + photoable w/ ambiguity), `findByPhotoable`, dry-run on create/update/delete, base-class guard on update, guard refusal on create/delete | +369 / -10 |
| `src/resources/public_photos.ts` | `resolve` (id + bounded record-pair scan), dry-run + guard refusal on create/update | +240 / -9 |
| `src/resources/exports.ts` | `resolve` (id + file name in one bounded fetch), `create` dry-run + guard refusal | +170 / -5 |
| `src/resources/s3_exports.ts` | `create` dry-run + guard refusal (no helper rows — SCOPING decision 14) | +54 / -4 |
| `src/types/upload.ts` | `UploadSummary` (drops `archived_at`) | +18 |
| `src/types/photo.ts` | `PhotoSummary` (drops `created_at`) | +18 |
| `src/types/export.ts` | `ExportSummary` (alias of `Export`; plan `compact: null`) | +7 |
| `src/types/index.ts` | 3 summary export lines — added BEFORE the coordinator's "do not edit the barrel" steer; left as is, not edited again (the coordinator completes the barrel at the gate; the file now shows +61 with other groups' lines) | +61 (3 mine) |
| `test/resources/uploads.test.ts` | appended agent-layer tests (existing file) | +255 |
| `test/resources/photos.test.ts` | new | 439 |
| `test/resources/public_photos.test.ts` | new | 281 |
| `test/resources/exports.test.ts` | new | 217 |
| `test/resources/s3_exports.test.ts` | new | 67 |

Not touched: `src/types/common.ts`, `src/http.ts`, `src/errors.ts`, `src/config.ts`, `src/logger.ts`,
`src/resources/base.ts`, `src/index.ts`, `scripts/**`, `capabilities*.json`, `capabilities.schema.json`,
`MCP_TOOL_MANIFEST.md`, `test/core-agent-layer.test.ts`, `test/public-surface.test.ts`,
`test/registry.test.ts`, `package.json`, `tsup.config.ts`, `vitest.config.ts`, `examples/**`, `.run/design/**`,
`README/CHANGELOG/docs`.

## Ruling applied (coordinator, after my first report)

`staleCheck` is **operation-shaped**: `updated_at` stays on `photos.update` (the only mutation of mine whose
path goes through `BaseResource.updateOne`); every create/delete row is now `unavailable`. Therefore I
**removed both bespoke guards** I had added and left `photos.update` on the base-class guard:

1. `photos.create` — the `expectedUpdatedAt` read-then-compare is gone (no read, no compare, no STALE_OBJECT on
   create, no duplicate detection). The JSDoc now states the create path has no stale guard.
2. `photos.delete` — the read-then-compare is gone; `delete()` is a plain `deleteOne(id, opts)`. JSDoc updated.
3. `photos.update` — unchanged: `updateOne(id, { photo: data }, undefined, opts)` keeps the base guard.
4. Tests: the three bespoke create-guard tests were deleted; the plan-titled
   `sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT` now covers the **update** path only
   (it is `photos.update`'s remaining `.stale` row). No other test was removed.
   `StaleObjectError` import + its placeholder assertion were removed from the test file (now unused).
5. **Follow-up ruling ("REJECT, not ignore") applied.** Every mutation path of mine that can never honour the
   guard now REFUSES it with `HuduConfigError` (code `CONFIG_ERROR`, category `validation`) BEFORE any request,
   via a private `refuseGuardOutsideUpdate(operation, opts)` whose message names the method:
   `"<op> : expectedUpdatedAt compares an existing revision, so it applies to update (PUT) only"` — the same
   convention and message shape impl-A2/impl-B2 landed in `folders`/`password_folders`/`websites`.
   Covered paths: `photos.create`, `photos.delete`, `uploads.upload`, `uploads.delete`,
   `public_photos.create`, `public_photos.update`, `exports.create`, `s3_exports.create`. The refusal runs
   before the dry-run branch, so a dry-run combined with `expectedUpdatedAt` is refused too (a dry-run must not
   claim a guard that can never run). `photos.update` still honours the guard through the base class.

Accepted by the coordinator, no action: unreachable `RESOLUTION_TRUNCATED`/`AMBIGUOUS` for id-only and
single-fetch resolves (the usage text says so); `type ExportSummary = Export` for the `compact: null` row;
my 3 barrel lines; my local helper plumbing instead of `src/resources/agent-layer-helpers.ts` (impl-C's module).

## Commands run (exact) and exit codes — after the ruling

```
npx vitest run test/resources/photos.test.ts test/resources/public_photos.test.ts \
  test/resources/exports.test.ts test/resources/s3_exports.test.ts test/resources/uploads.test.ts
  -> exit 0, 5 files, 116 tests passed
     (114 before the first ruling - 3 removed create-guard tests + 5 added guard-refusal tests)

npx eslint src/resources/uploads.ts src/resources/photos.ts src/resources/public_photos.ts \
  src/resources/exports.ts src/resources/s3_exports.ts src/types/upload.ts src/types/photo.ts \
  src/types/export.ts test/resources/uploads.test.ts test/resources/photos.test.ts \
  test/resources/public_photos.test.ts test/resources/exports.test.ts test/resources/s3_exports.test.ts
  -> exit 0, no output

npx tsc --noEmit | grep -E 'resources/(uploads|photos|public_photos|exports|s3_exports)|types/(upload|photo|export)'
  -> no output (zero errors in my files). Project-wide tsc is still red ONLY in files owned by other
     implementers: src/resources/folders.ts(287) TS6133, src/resources/password_folders.ts(324) TS6133,
     src/resources/procedures.ts(297) TS2558, src/resources/websites.ts(244,367) TS2554,
     src/types/procedure.ts(90) TS2552. Reported, not fixed.

# own-file coverage (measured against MY files only; thresholds zeroed for the measurement)
npx vitest run --coverage --coverage.reporter=json \
  --coverage.include='src/resources/{uploads,photos,public_photos,exports,s3_exports}.ts' \
  --coverage.thresholds.{lines,statements,functions,branches}=0 <my 5 test files>
  -> exit 0; statements 100% and functions 100% on all five files; branches:
     exports.ts 86.4, photos.ts 89.9, public_photos.ts 93.6, s3_exports.ts 100, uploads.ts 94.8
```

`npm test`, `npm run capabilities:build`, `capabilities:check`, `npm run build`, `npm pack` and `scripts/*`
were NOT run (other implementers are still writing; those belong to the coordinator's batch gate).

## Plan test titles (the row `tests[]` contract)

**77 / 77 test rows for my 22 plan rows exist verbatim — 0 missing** (machine-checked against the updated
`capabilities.plan.json`: exact `it('<title>')` in the named file). The count fell from 79 to 77 because the
plan dropped the `.stale` row from `photos.create` and `photos.delete`.

* `uploads.test.ts` (28): resolve id / id miss / unsupported kind / UploadSummary / expand / resolutionDetails;
  delete + dry-run; list; get; upload + dry-run; correlation id (success + error + effect + resourceIds).
* `photos.test.ts` (39): resolve id / id miss / single exact match / AMBIGUOUS / PhotoSummary / expand /
  resolutionDetails / TRUNCATED at the 4-page cap / null after a complete scan / unsupported kind;
  findByPhotoable (list, empty, limit cap + rejection, expand); primitives; create/update/delete dry-run;
  `sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT` on update (GET then refusal, no PUT);
  correlation ids.
* `public_photos.test.ts` (24): resolve id / id miss / bounded record-pair scan / null after complete scan /
  TRUNCATED at the 1-page cap (1 HTTP call) / resolutionDetails / unsupported kinds; list, get, create, update
  (singleKey unwrap), dry-runs, correlation.
* `exports.test.ts` (21): resolve id / id miss / file name in ONE bounded fetch / null after complete scan /
  ExportSummary / expand / resolutionDetails; list never sends `page/page_size`; get; create (void); dry-run
  warning that there is no server-computed result to promise; correlation.
* `s3_exports.test.ts` (4): void create, dry-run (no request, `simulated: true`, empty-200 warning), correlation.

Every helper also has extra rows beyond the plan: unique match, complete-scan miss, truncated scan where
reachable, the bounded cap asserted by HTTP-call count, and compact-vs-expand field loss
(`UploadSummary` drops `archived_at`; `PhotoSummary` drops `created_at`).

## Hard rules — how they are met

* `resolve` never lies: `{ id }` miss → `NOT_FOUND` (via `getOne`); `null` only from a complete scan;
  a cap that stopped the search → `RESOLUTION_TRUNCATED` (`BaseResource.requireResolved`, never `null`);
  several photoable matches → `RESOLUTION_AMBIGUOUS` with candidate ids in `resourceIds`; an unsupported
  identifier kind → `HuduConfigError` (category `validation`) naming the accepted kinds, no request issued.
* Every scan goes through `BaseResource.boundedScan`; no unbounded `Promise.all`. The only list helper
  (`photos.findByPhotoable`) uses the vendor filter with `page_size = limit`, default 25, hard max 100 →
  `HuduConfigError` above it (never clamped).
* Dry-run paths issue ZERO requests: `photos.create/update/delete`, `public_photos.create/update`,
  `uploads.upload/delete`, `exports.create`, `s3_exports.create` (asserted with a fetch spy).
* Additive only: every primitive keeps its previous signature/behaviour; new arguments are optional trailing
  `opts`. `operation` tags added to hand-rolled requests are audit/error metadata only.
* No generated file, threshold, `.skip` or `--no-verify` touched.

## Gaps / notes

1. **Stale guard scope — RESOLVED.** The only mutation of mine carrying the opt-in guard is `photos.update`
   (via `updateOne`). Every other mutation path refuses `expectedUpdatedAt` with `HuduConfigError`
   (`CONFIG_ERROR` / `validation`, no request issued) — see "Ruling applied" point 5. Each of the five test
   files has one extra (non-plan) row asserting the refusal and the zero-request behaviour, including the
   dry-run variant. Note for the base owner: if `createOne`/`deleteOne`/`setArchived` also start rejecting
   centrally, my pre-checks simply run first (same error, same message shape) — no behaviour change, no
   double request. My `deleteOne` callers (`photos.delete`, `uploads.delete`) keep the check because the
   base change had not landed when this was written.
2. **Unreachable error codes (accepted by the coordinator, no action)** — `RESOLUTION_TRUNCATED` is
   structurally unreachable for `uploads.resolve` (id-only direct fetch) and `exports.resolve` (a
   non-paginated fetch always reports `hasMore: false`); `RESOLUTION_AMBIGUOUS` is unreachable for
   `uploads.resolve` (id-only), `public_photos.resolve` (single bounded page, first match) and
   `exports.resolve` (single bounded fetch, first exact `file_name` match). The plan's `errors` column lists
   them family-wide; each row's `usage` says "one page" / "a single bounded fetch".
3. **`ExportSummary` is a type alias of `Export`** (`export type ExportSummary = Export`) because the plan row
   records `compact: null` and the record is already compact. Accepted; keeps the signature uniform.
4. **Not fixed (not mine)** — the six project-wide `tsc` errors listed above.
5. **Status flip pending** — my 22 rows stay `status: "planned"` (file off-limits to me); the coordinator
   flips them at the batch gate. All 77 titles already exist, which is what the flip asserts.
6. **Plan-text noise, no code impact** — `uploads.delete.metadata.preferredWhen` points at `uploads.archive`,
   which has no plan row and no endpoint in `api-docs.json` (uploads expose upload/get/list/delete only).

## QA fix — false safety claim in dry-run `impact.reversible` (independent reviewer, 2026-09-12)

`exports.create` and `s3_exports.create` claimed `reversible: true` in their dry-run results, but
`api-docs.json` gives `/exports` GET+POST, `/exports/{id}` GET, and `/s3_exports` POST only — there is no
DELETE and no cancel. An agent reading `reversible === true` was told the opposite of the truth.

Fixed: `reversible: false` plus an explicit warning on both — "an export runs asynchronously and the API
exposes no cancel or delete path for it, so this cannot be undone". The existing "no server-computed result
to promise" warning is kept (the results now carry two warnings).

**Same class found by my own re-audit of every dry-run in my five files and fixed:**
`public_photos.create` also claimed `reversible: true`, but `/public_photos` is GET+POST and
`/public_photos/{id}` is GET+PUT only — no DELETE. It is now `reversible: false` with the warning "the API
exposes no delete path for a public photo, so this create cannot be undone (it can only be re-associated with
public_photos.update)".

**Audited and left as they are (each `reversible` claim now has a named compensating path):**

| Dry-run | `reversible` | Why that is honest |
|---|---|---|
| `photos.create` | `true` | `DELETE /photos/{id}` exists, so the created row can be removed |
| `photos.update` | `true` | the prior field values can be written back with another PUT |
| `photos.delete` | `false` | destructive, and no undelete/restore endpoint exists |
| `public_photos.update` | `true` | the prior `record_type`/`record_id` association can be written back |
| `uploads.upload` | `true` | `DELETE /uploads/{id}` exists, so the uploaded file can be removed |
| `uploads.delete` | `false` | destructive; uploads have no archive/restore endpoint |

`impact.affected` is `1` with `scope: 'single'` on every path of mine — none of them touches a
server-computed set, so no `exact: false` (floor) claim is needed and the new optional `impact.exact` flag is
deliberately unused.

Tests added (extra, non-plan): `exports.test.ts` and `s3_exports.test.ts` each assert the create dry-run's
`impact` is exactly `{ affected: 1, scope: 'single', reversible: false }`, that the undo warning is present and
that ZERO requests are issued; `public_photos.test.ts` asserts the same for `public_photos.create`. The two
pre-existing warning-count assertions were updated from 1 to 2 warnings.

Post-fix commands: `npx vitest run <my 5 test files>` -> **exit 0, 119 tests passed** (photos 39,
uploads 28, public_photos 25, exports 22, s3_exports 5). `npx eslint <my 13 files>` -> **exit 0**.
`npx tsc --noEmit` filtered to my files -> no errors.
