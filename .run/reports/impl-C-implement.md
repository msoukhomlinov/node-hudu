# impl-C implement report — group C (operations & workflow)

Run: node-hudu backfill (api-node-squad 3.0.1) · branch `feat/agent-execution-layer` · implementer impl-C
Resources owned: procedures, procedure_tasks, cards, activity_logs, expirations, matchers, magic_dash, api_info
Plan rows owned: 42 (29 primitive + 13 helper) · plan test titles owned: **152 / 152 present** (all verbatim)

## 1. Files changed (new / appended lines)

| file | lines | what |
|---|---|---|
| `src/resources/agent-layer-helpers.ts` | 159 (new) | shared helper-tier plumbing: `helperLimit` (default 25 / hard max 100, `HuduConfigError` above), `decideResolution` (TRUNCATED / AMBIGUOUS / NOT_FOUND / null), `identifierError`, `requirePositiveId`, `numericIds`, `refuseClientScan` |
| `src/resources/procedures.ts` | 393 | dry-run/stale/opts overloads on create/update/delete/duplicate/createFromTemplate/kickoff; `resolve`, `getWithTasks` |
| `src/resources/procedure_tasks.ts` | 201 | same overloads; `resolve`; `toProcedureTaskSummary` |
| `src/resources/cards.ts` | 139 | `operation` on lookup; `resolve` (lookup filters only, never invents CRUD) |
| `src/resources/activity_logs.ts` | 278 | `deleteAll` dry-run + `POLICY_DENIED` bound; `resolve` (bounded client scan); `findByResource` |
| `src/resources/expirations.ts` | 261 | opts overloads; `resolve`; `findByResource`; scan-based stale guard on update |
| `src/resources/matchers.ts` | 191 | opts overloads; `resolve` (sync_id / identifier / id); `findBySyncId` |
| `src/resources/magic_dash.ts` | 361 | dry-run + POLICY_DENIED gates on delete / deleteById / updatePositions; `resolve`; `findByCompany` |
| `src/resources/api_info.ts` | 43 | `operation` on get; degenerate `resolve` (one request, identifier ignored) |
| `src/types/procedure.ts` | 94 | `ProcedureIdentifier`, `ProcedureSummary`, `ProcedureWithTasks`, `ProcedureWithTasksFull` |
| `src/types/procedure_task.ts` | 80 | `ProcedureTaskIdentifier`, `ProcedureTaskSummary` |
| `src/types/integrator_card.ts` | 60 | `IntegratorCardIdentifier`, `IntegratorCardSummary` |
| `src/types/activity_log.ts` | 40 | `ActivityLogIdentifier`, `ActivityLogSummary` |
| `src/types/expiration.ts` | 62 | `ExpirationIdentifier`, `ExpirationSummary` |
| `src/types/matcher.ts` | 38 | `MatcherIdentifier` (no compact: 9 small fields) |
| `src/types/magic_dash.ts` | 57 | `MagicDashIdentifier`, `MagicDashSummary` |
| `test/resources/procedures.test.ts` | 624 (baseline 88 + appended) | 38 plan titles + 9 baseline + 3 edge suites |
| `test/resources/procedure_tasks.test.ts` | 358 (new) | 24 plan titles + 2 edge suites |
| `test/resources/cards.test.ts` | 205 (new) | 8 plan titles + 2 edge suites |
| `test/resources/activity_logs.test.ts` | 302 (new) | 16 plan titles + 2 edge suites |
| `test/resources/expirations.test.ts` | 364 (new) | 21 plan titles + 2 edge suites |
| `test/resources/matchers.test.ts` | 306 (new) | 17 plan titles + 2 edge suites |
| `test/resources/magic_dash.test.ts` | 454 (new) | 29 plan titles + 2 edge suites |
| `test/resources/api_info.test.ts` | 82 (new) | 4 plan titles |

No DO-NOT-TOUCH file was modified. I did not touch `src/types/index.ts`, `capabilities.plan.json`, `scripts/**`,
`src/capabilities.ts`, `src/types/common.ts`, `base.ts`, `http.ts`, `errors.ts`, or any other group's files.

## 2. Preservation of the coordinator's ruling (message agentmsg_93cd7c4c)

* `staleCheck: "updated_at"` is implemented ONLY on `procedures.update`, `procedure_tasks.update`,
  `expirations.update` (all three via the opt-in `{ expectedUpdatedAt }` guard).
* The stale guards I had added to `procedures.delete`, `procedure_tasks.delete` and `expirations.delete`
  were REMOVED, and the three `.stale` create/delete tests plus the two `.stale` tests the ruling deleted
  from the plan (5 tests) were REMOVED as well. Deletes now pass `MutationOptions` straight to
  `deleteOne` (`expectedUpdatedAt` not consulted), documented in each method.
* `procedures.create` / `procedure_tasks.create` accept `MutationOptions` for `{ dryRun: true }` only;
  `expectedUpdatedAt` is a documented no-op there (base.ts applies the guard on the update path only).
* Plan re-read after the ruling: 42 rows, 152 test titles, 3 rows with `staleCheck: "updated_at"`.

## 3. Commands and exit codes

| command | exit | result |
|---|---|---|
| `npx tsc --noEmit` | **2** | 2 errors, both in files I do NOT own (see §5) — my files are clean |
| `npx eslint <8 src resource + 8 type + 8 test files>` | **0** | no findings |
| `npx vitest run test/resources/{procedures,procedure_tasks,cards,activity_logs,expirations,matchers,magic_dash,api_info}.test.ts` | **0** | 8 files, **186 tests passed** |
| `npx vitest run <same 8> --coverage --coverage.include='src/resources/<my 9>.ts' --coverage.all=false` | **0** | my files: **98.68 % stmts / 87.22 % branch / 100 % funcs / 99.15 % lines** |

I did not run `npm test`, `capabilities:build`, `capabilities:check`, `node scripts/*.mjs`, `npm run build`
or `npm pack` (the coordinator's batch gate owns them).

## 4. Behaviour implemented per hard rule

* `{ id }` miss throws `NOT_FOUND` (never `null`): direct `getOne` (procedures, procedure_tasks) or a
  bounded scan with `definite: true` (activity_logs, expirations, magic_dash, matchers).
* `null` only after a COMPLETE scan; a cap that stopped the search throws `RESOLUTION_TRUNCATED`
  (`allowClientScan: false` refuses the fallback scan with the same code).
* Several inexact matches throw `RESOLUTION_AMBIGUOUS` with candidate ids in `resourceIds`.
* An identifier kind the vendor cannot support throws `HuduConfigError` naming the accepted kinds
  (e.g. `matchers.resolve` without `integration_id`, `cards.resolve` without `integration_slug`).
* Every scan goes through `BaseResource.boundedScan`; every list helper honours `limit`
  (default 25, hard max 100 → `HuduConfigError`, never a silent clamp).
* Dry-run never writes: asserted with a stub that fails on ANY request (`expect(spy.calls).toHaveLength(0)`).
* `/procedure_tasks` never receives `page`/`page_size` (asserted for `list` and for the helper scan).
* Bulk shapes: `activity_logs.deleteAll` (empty `datetime`), `magic_dash.delete` (empty title/company_name)
  and `magic_dash.updatePositions` (no positions) throw `POLICY_DENIED` before any request and declare
  `impact.scope: "bulk"`; `magic_dash.deleteById` is bounded by its id (its row declares no POLICY_DENIED)
  and rejects a non-positive id with a structured `CONFIG_ERROR`.
* `cards` has only lookup/jump + `resolve` — no invented get/create/update/delete.
* `api_info.resolve` issues exactly ONE request and ignores the identifier (documented degenerate case).

## 5. Gaps / UNVERIFIED

1. **UNVERIFIED — generator cannot derive `outputSchema.drops` for union / array return types.**
   `scripts/generate-capabilities.mjs` (`outputSchema()`, ~line 325) calls `resolveProps(method.returnType)`.
   With the design-doc signature pattern the implementation signature returns a UNION
   (`ProcedureSummary | Procedure | null | Resolution<ProcedureSummary>`), so `resolveProps` returns null →
   `dropsUnresolved: true`, `drops: []` → `check-capabilities` rule `helper-compact-drops` FAILS for every
   compact helper row once its status flips to `implemented` (all four groups, not only C). Array-returning
   helpers (`activity_logs.findByResource` → `ActivityLogSummary[]`, `matchers.findBySyncId`, …) fail the same
   way. Evidence: a read-only replica of the generator's own parse logic (no repo script executed, writes to
   /tmp only): `node /tmp/rep.mjs /tmp/repdir '{"procedures.resolve":"ProcedureSummary"}'` →
   `rt="ProcedureSummary | Procedure | null | Resolution<ProcedureSummary>" … fullResolved=false drops=[]`.
   Proposed fix (coordinator owns `scripts/**`): before `resolveProps`, reduce the return type — strip a
   trailing `| null`/`| undefined`, strip `[]`/`Array<…>`, and if it is still a union pick the first member
   that resolves. I did NOT touch the generator.
2. **UNVERIFIED — 2 pre-existing/other-agent tsc errors (files I do not own):**
   `src/index.ts(35,1): TS2308 'CompanySummary' already exported` (a summary declared in both `common.ts` and a
   resource type file) and `src/resources/s3_exports.ts(60,17): TS2304 Cannot find name 'HuduConfigError'`.
   Both come from concurrent agents; I did not fix them.
3. **Design deviation, documented in code — `expirations` has no single-get.** `api-docs.json` declares
   `/expirations/{id}` for PUT/DELETE only and `GET /expirations` has no id filter, so:
   (a) `expirations.resolve` id kind is implemented as a bounded client scan (`resolutionCost: 'client-scan'`)
   although the plan row records `resolution.basis: "server-filter"` (the resource-pair kind IS server-filter);
   (b) `expirations.update`'s `expectedUpdatedAt` guard reads the current revision through that same bounded
   scan instead of base's `getOne` (which would 405). The `.stale` test proves STALE_OBJECT works.
4. **UNVERIFIED — registry/MCP projection side effect.** Because the mutation primitives now declare overloads,
   the generator records their implementation return type, so `outputSchema.type` becomes a union
   (e.g. `Procedure | DryRunResult<Procedure>`) instead of `Procedure`. `test/registry.test.ts` only asserts
   truthiness, so nothing breaks there, but the MCP tool projection will describe those outputs as unions.
5. **Branch coverage of my files is 87.22 %** (≥ 83 threshold); statements 98.68 % / lines 99.15 % measured
   with ONLY my 8 test files over only my 9 source files. The full-suite aggregate is the coordinator's to take.
6. `activity_logs.unwrapList`'s two envelope branches and the `list`/`listPages` iterators of several resources
   show as uncovered in my isolated run because they are exercised by the pre-existing `special.test.ts` and
   `crud-resources.test.ts`, which my isolated coverage run does not collect.

## 6. Not done (explicitly out of scope)

No git commit / push (coordinator commits). No MCP manifest change, no registry regeneration, no
`capabilities.plan.json` edit, no `src/types/index.ts` edit (coordinator adds the new summary/identifier
exports at the batch gate).


---

# QA fixes (round 2) — bulk dry-run floors + shared guard-refusal helper

## FIX 1 — bulk-delete dry-run floors (HIGH)

`activity_logs.deleteAll` and `magic_dash.delete` no longer report a literal `affected: 1`.
Each dry-run now runs ONE bounded READ (`page_size = MAX_HELPER_LIMIT` = 100) with the same
filter and reports the count as a floor:

* `activity_logs.deleteAll`: `GET /activity_logs?start_date=<datetime>&page=1&page_size=100`
  (`start_date` is the read-side filter the spec declares for this collection).
* `magic_dash.delete`: `GET /magic_dash?title=<title>&page=1&page_size=100`, counting only the
  items that match BOTH bounds (`title` AND `company_name`), which is what the delete targets.

Both now set `impact.exact: false` (base supports `DryRunOperation.exact` → `impact.exact`) with a
refreshed warning: `affected <n> is a FLOOR from ONE bounded page (page_size 100) …; the server
decides the final target set`. `magic_dash.updatePositions` sets `exact: true` (the caller supplies
the bound, so `positions.length` IS the affected set). The dry-run still issues NO mutating request
(asserted: exactly one GET, zero DELETEs).

Tests: 3 existing dry-run tests per operation updated (the "issues no request" titles are verbatim
from the plan, so they assert "one GET and zero mutating requests" with a comment), plus ONE new test
per operation asserting `exact === false`, the single pre-read GET, `page_size=100` in its URL, the
`DELETE` in `request.method`, and the warning text.

## FIX 2 — one shared guard-refusal helper (LOW)

`refuseExpectedUpdatedAtOutsideUpdate(operation, opts)` added to `src/resources/agent-layer-helpers.ts`
(75 lines → 88 lines total in that module) and adopted in the SIX group-C resource files that both
import the module and own a non-update mutating path:

`procedures.ts` (create, delete, duplicate, createFromTemplate, kickoff), `procedure_tasks.ts`
(create, delete), `expirations.ts` (delete), `matchers.ts` (update — its plan row records
`staleCheck: "unavailable"` and the vendor has no `GET /matchers/{id}` — and delete),
`magic_dash.ts` (create, delete, deleteById, updatePositions), `activity_logs.ts` (deleteAll).

Left untouched on purpose: `cards.ts` and `api_info.ts` (no mutating path accepting `MutationOptions`),
and the 15 files owned by other implementers that still hold equivalent local copies (accepted debt):
`exports.ts`, `s3_exports.ts`, `uploads.ts`, `photos.ts`, `public_photos.ts` (`refuseGuardOutsideUpdate`),
`folders.ts`, `websites.ts`, `password_folders.ts` (`refuseGuardOnCreateOrDelete`), `labels.ts`,
`lists.ts`, `flags.ts`, `flag_types.ts`, `relations.ts`, `rack_storage_items.ts`, `label_types.ts`
(`refuseExpectedUpdatedAt`) — 16 definitions in total, not 17.

**IMPORTANT premise mismatch:** no group-C file had a local guard-refusal definition to replace (the
ruling had already removed the create/delete guards from my files), so FIX 2 became a behaviour change
in my files: `expectedUpdatedAt` on a create/delete/special write was previously IGNORED and is now
REFUSED with `HuduConfigError` (`code: CONFIG_ERROR`, message prefix
`<operation>: expectedUpdatedAt compares an existing revision, so it applies to update (PUT) only`,
plus `this path records staleCheck "unavailable" and would never run the guard.`). That matches the
semantics the other 15 files implement. Update paths keep the guard unchanged
(`procedures.update`, `procedure_tasks.update`, `expirations.update`).

Message equivalence: the prefix is byte-identical to the `folders.ts`/`exports.ts` wording; the
appended clause is new text. No test in my files asserted the old message, so no test needed a
message update — the new tests assert `err.code === 'CONFIG_ERROR'` and
`expect(err.message).toContain('update (PUT) only')`.

## Commands after the fixes

| command | exit | result |
|---|---|---|
| `npx tsc --noEmit` | **0** | 0 errors project-wide (the two other-agent errors from round 1 are gone) |
| `npx eslint <8 src resource + 8 type + 8 test files>` | **0** | no findings |
| `npx vitest run <my 8 test files>` | **0** | 8 files, **194 tests passed** (was 186: +8 from these fixes) |
| `npx vitest run <same 8> --coverage --coverage.include='src/resources/<my 9>.ts'` | **0** | 98.74 stmts / 87.35 branch / 100 funcs / 99.19 lines |

All 152 plan test titles are still present verbatim.


---

# QA fixes (round 3) — executed audit impact must equal the dry-run impact

## Hand-rolled mutating methods fixed (each now builds ONE `OperationImpact` and passes it to
## BOTH `buildDryRunResult` and the live `http.request({ …, impact })`, exactly the base.ts pattern)

| operation | impact | channel parity test |
|---|---|---|
| `procedures.duplicate` | `{affected: 1, scope: 'single', reversible: true}` | yes |
| `procedures.createFromTemplate` | `{affected: 1, scope: 'single', reversible: true}` | yes |
| `procedures.kickoff` | `{affected: 1, scope: 'single', reversible: true}` + undo warning | yes |
| `activity_logs.deleteAll` | `{affected: <pre-read floor>, scope: 'bulk', reversible: false, exact: false}` | yes |
| `magic_dash.delete` | `{affected: <pre-read floor>, scope: 'bulk', reversible: false, exact: false}` | yes |
| `magic_dash.deleteById` | `{affected: 1, scope: 'single', reversible: false}` | yes |
| `magic_dash.updatePositions` | `{affected: positions.length, scope: 'bulk', reversible: true, exact: true}` | yes |

The two bulk deletes now take the SAME bounded pre-read floor on the LIVE path (one GET, page_size 100)
that the dry-run takes, so the audit event of the executed delete reports the same blast radius instead of
the transport's per-verb `{affected: 1, scope: 'single'}` guess. Cost: one extra READ per bulk delete.

Base-routed mutations (`procedures.create/update/delete`, `procedure_tasks.*`, `expirations.update/delete`,
`matchers.update/delete`, `magic_dash.create`) already inherit base.ts's threaded impact; one parity test per
file proves it (`procedure_tasks`, `expirations`, `matchers`). Reads never claim an impact (`api_info.get` test).

## Reversible claims and their compensating undo path

* `procedures.duplicate`, `procedures.createFromTemplate`: the 201 response returns the new process with its id →
  undo = `procedures.delete(newId)`.
* `procedures.kickoff`: undo = `procedures.delete(runId)`; the vendor documents
  `DELETE /procedures/{id}` as "Delete a Process or Run — Remove a process or run by its ID", so a RUN is removable.
  The kickoff response is `{message}` only, so the run id must be discovered first; the dry-run now carries that
  caveat as an explicit warning ("discover the new run id with procedures.list before relying on the undo path").
* `procedures.update`, `procedure_tasks.update`, `expirations.update`, `matchers.update`: undo = re-write the previous
  field values (re-writable fields + the opt-in `expectedUpdatedAt` guard).
* `magic_dash.create`: undone by `magic_dash.deleteById(newId)` (the create response returns the item).
* `magic_dash.updatePositions`: undo = the same call with the previous positions (now named in a warning).
* Every delete (`procedures.delete`, `procedure_tasks.delete`, `expirations.delete`, `matchers.delete`,
  `magic_dash.delete`, `magic_dash.deleteById`, `activity_logs.deleteAll`) claims `reversible: false`.

## Commands after round 3

| command | exit | result |
|---|---|---|
| `npx tsc --noEmit` | **0** | 0 errors project-wide |
| `npx eslint <my 16 src/type + 8 test files>` | **0** | no findings |
| `npx vitest run <my 8 test files>` | **0** | 8 files, **203 tests passed** (194 → 203: +9 impact-parity/undo tests) |


---

# QA fix (round 4) — regression repair: the executed bulk delete keeps its one-request shape

Round 3 gave the LIVE paths of `activity_logs.deleteAll` and `magic_dash.delete` the same bounded
pre-read as the dry-run. That changed an existing primitive's observable behaviour (GET-then-DELETE)
and broke two pre-existing 0.2.1 tests in `test/resources/special.test.ts` (the request-shape pins).
Repair, exactly as instructed:

1. The LIVE path issues NO pre-read again: ONE request, the mutating one. The pre-read stays in the
   DRY-RUN path only (still `page_size 100`, still reporting `affected: <floor>` with `exact: false`).
2. The executed impact for both is now `{ affected: 1, scope: 'bulk', reversible: false, exact: false }`
   — `exact: false` labels `affected` as a LOWER BOUND ("at least one record; the server computes the
   real set") and `scope: 'bulk'` states the shape. It is NOT `scope: 'single'` and NOT exact. Both
   resources declare it once as an `EXECUTED_BULK_DELETE_IMPACT` constant, derived with no request.
3. Parity tests updated for these two operations only: they assert the dry-run and the executed audit
   event share `scope` and `reversible`, that BOTH are `exact: false`, and that the executed call is a
   single request. Every other operation (where both sides are exact) keeps the deep-equal assertion.
4. `test/resources/special.test.ts` was NOT edited and passes again unchanged: 40 tests.
5. The dry-run's bounded pre-read and its `affected: <floor>` are unchanged.

## Commands after round 4

| command | exit | result |
|---|---|---|
| `npx tsc --noEmit` | **0** | 0 errors project-wide |
| `npx eslint <my 16 src/type + 8 test files>` | **0** | no findings |
| `npx vitest run test/resources/{activity_logs,magic_dash,special}.test.ts test/resources/procedures.test.ts` | **0** | 4 files, **151 tests passed** (special.test.ts included as the regression proof) |
| `npx vitest run <my 8 test files>` | **0** | 8 files, **203 tests passed** |

Live-path impacts after round 4:

* `activity_logs.deleteAll` executed → `{ affected: 1, scope: 'bulk', reversible: false, exact: false }`
* `magic_dash.delete` executed → `{ affected: 1, scope: 'bulk', reversible: false, exact: false }`
