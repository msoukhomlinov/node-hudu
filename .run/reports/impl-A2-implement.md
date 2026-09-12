# impl-A2 — Group A implementer (websites, folders, password_folders, groups)

Branch: `feat/agent-execution-layer` · Run: `node-hudu-backfill-20260912` · Date: 2026-09-12

## Files changed

| Path | Owner | Lines now | Delta |
|------|-------|-----------|-------|
| `src/resources/websites.ts` | mine | 345 | rewritten (was 44) |
| `src/resources/folders.ts` | mine | 304 | rewritten (was 44) |
| `src/resources/password_folders.ts` | mine | 340 | rewritten (was 49) |
| `src/resources/groups.ts` | mine | 263 | rewritten (was 33) |
| `src/types/website.ts` | mine | 57 | +10 (`WebsiteIdentifier`) |
| `src/types/folder.ts` | mine | 52 | +27 (`FolderSummary`, `FolderIdentifier`) |
| `src/types/password_folder.ts` | mine | 49 | +24 (`PasswordFolderSummary`, `PasswordFolderIdentifier`) |
| `src/types/group.ts` | mine | 47 | +20 (`GroupSummary`, `GroupIdentifier`) |
| `test/resources/websites.test.ts` | mine | 411 | new (33 tests) |
| `test/resources/folders.test.ts` | mine | 339 | new (31 tests) |
| `test/resources/password_folders.test.ts` | mine | 368 | new (29 tests) |
| `test/resources/groups.test.ts` | mine | 262 | new (23 tests) |
| `src/types/index.ts` | coordinator | — | +10 (5 re-export lines, added BEFORE the steer; left untouched since) |

No generated file, shared core file (`common.ts`, `http.ts`, `errors.ts`, `config.ts`, `logger.ts`, `base.ts`, `index.ts`), script, manifest, config or doc was edited. No commit, no push.

## Commands run (exact) and exit codes

| Command | Exit |
|---------|------|
| `npx tsc --noEmit` | 0 (project-wide green) |
| `npx eslint src/resources/{websites,folders,password_folders,groups}.ts src/types/{website,folder,password_folder,group}.ts test/resources/{websites,folders,password_folders,groups}.test.ts` | 0 |
| `npx vitest run test/resources/websites.test.ts test/resources/folders.test.ts test/resources/password_folders.test.ts test/resources/groups.test.ts` | 0 — 4 files, 116 tests passed |
| `npx vitest run <those 4 files> --coverage --coverage.reporter=json` | 0 — my 4 resource files: 100 % stmts / 100 % branch / 100 % func |
| `git status`, `git diff --numstat` | 0 |

Forbidden commands were NOT run: `capabilities:build`, `capabilities:check`, `node scripts/*.mjs`, `build`, `pack`.

## Plan test titles

All required titles for my 25 rows (8 helper rows + 17 primitive rows) exist verbatim: **77/77 titles, 0 missing**, verified programmatically against `capabilities.plan.json` (`it('<exact title>')` present in the named file).

- helpers: `websites.{resolve,findBySlug,search}`, `folders.resolve`, `password_folders.{resolve,search}`, `groups.{resolve,search}` — every row's titles present.
- primitives: `websites.{list,get,create,update,delete}`, `folders.{…}`, `password_folders.{…}`, `groups.{list,get}` — every row's titles present, including `dry-run issues no …`, the shared `…correlation id…` title (one test covers read + write, success + error) and `sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT` (update path).

Tests missing: **none**.

## Contract implemented

- `resolve` never lies: `{ id }` miss → `NOT_FOUND` (never null); `null` only after a complete scan; a cap-stopped scan → `RESOLUTION_TRUNCATED`; >1 exact match → `RESOLUTION_AMBIGUOUS` with candidate ids in `resourceIds`; an unsupported identifier kind → `ValidationFailedError` naming the accepted kinds, with **zero** HTTP calls. `resolutionDetails: true` returns cost/`scanned`/`scanTruncated`/`candidates`; bare-value order is id → slug → exact name (websites, groups) / id → exact name (folders, password_folders).
- Every scan goes through `BaseResource.boundedScan` (25/page, 4 pages, 500 records by default); every list-shaped helper honours `limit` (default 25, hard max 100 → `HuduConfigError`, never clamped, one HTTP call); no unbounded `Promise.all`.
- Dry-run never writes (asserted with a fetch spy: zero calls); `expectedUpdatedAt` on update goes through `updateOne`'s read-then-compare → `STALE_OBJECT`.
- Additive only: existing `get/list/listAll/listPages/create/update/delete` signatures, wrappers and behaviour unchanged; only new overloads added.

## Gaps / UNVERIFIED

1. **UNVERIFIED — `src/types/index.ts`**: I added 5 re-export lines before the "do not edit the barrel" steer. They are still there (per instruction not to edit it again). If the batch gate adds the same lines, TS will report duplicate re-exports. My resource files import from their own type files (`../types/website.js`), so **my files need no barrel change** — the 10 lines can be dropped safely.
2. **`websites` compact shape is the core `WebsiteSummary` (src/types/common.ts), used as-is per SCOPING decision 6** — it does NOT match `A.md §2`, which lists `slug`, `company_name`, `status`, `url`, `updated_at` as kept. `common.ts` is frozen and not mine, so I used the declared shape; the plan's `compact: "WebsiteSummary"` resolves to it, and the drops are derived from `Website` minus that shape. Consequence, flagged for the coordinator: `slug` is dropped from the compact websites shape even though it is a resolve-by kind. Fix (if wanted) belongs in `common.ts`, owned by the core implementer.
3. **UNVERIFIED against the live vendor — `websites.update` `staleCheck: updated_at`**: the Hudu 2.45.1 spec definition `Website` declares **no** `updated_at` field, so on a live API the opt-in guard would read `undefined` and report STALE_OBJECT for any expectation. The guard is opt-in (undefined by default) so no existing call changes; verified only against the mocked transport.
4. **Plan changed mid-flight**: the coordinator set `staleCheck: unavailable` on all create/delete rows and removed their `.stale` test titles. I aligned: create/delete now **refuse** `expectedUpdatedAt` with `HuduConfigError` (`CONFIG_ERROR`) instead of running a guard, and the shared stale test covers the update path only. I had briefly implemented a create-time guard; that code is gone.
5. **`groups` slug lookup** uses the vendor `search` filter plus an exact `slug` compare (no `slug` filter exists on `/groups`), reported as `resolutionCost: 'server-filter'`. Extra `search` calls on account-wide lookups are bounded by the scan caps.
6. **Duplication, not a defect**: `src/resources/agent-layer-helpers.ts` appeared during this run (another implementer's file, not mine). Each of my 4 files carries its own small private `scanExact`/`decideScan` pair (~90 lines each). Consolidation is a coordinator call; not done to avoid cross-file churn while 6 implementers write concurrently.
7. **UNVERIFIED — group-level gates**: `npm test` (whole suite), coverage thresholds 97/94/83/97, `capabilities:build/check` and the MCP projection were not run by me (forbidden / other agents' files in flight). My four files are at 100 % statement/branch/function coverage under my own four test files.

## Housekeeping note

`coverage/` exists in the working tree: it is the gitignored output of my `--coverage` measurement run (`.gitignore` line 3). The safety guard blocked its removal in autonomous mode; delete it with `rm -rf coverage` if you want a clean tree. It is an ignored artifact, not a source change.

## Addendum — staleCheck ruling (coordinator, same day)

Re-read my 25 rows after the ruling. Aligned state, verified programmatically:

- `websites.update`, `folders.update`, `password_folders.update`: `staleCheck: "updated_at"`, guard runs via `updateOne`, and exactly one `.stale` test title each (`sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT`), which exercises the update read-then-compare only.
- Every create/delete row of mine: `staleCheck: "unavailable"`, no `STALE_OBJECT` in `errors`, no `.stale` test row. No guard code exists on those paths — `expectedUpdatedAt` there throws `HuduConfigError` (`CONFIG_ERROR`) instead of silently doing nothing.
- Read/helper rows: `staleCheck: null` (unchanged, correct).
- Docstrings on the three delete methods no longer claim the guard (they say `staleCheck: unavailable`).

Re-ran after the docstring fix: `npx tsc --noEmit` 0, `npx eslint <my 8 src files + 4 test files>` 0, `npx vitest run <my 4 test files>` 0 (116 tests).
