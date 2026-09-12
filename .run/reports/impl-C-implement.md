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
