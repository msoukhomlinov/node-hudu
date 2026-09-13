# Mutation Safety — Live Vendor Test (node-hudu)

- **Date:** 2026-09-12 21:00 → 2026-09-13 01:20 UTC
- **Tenant:** Hudu 2.45.1 sandbox `hudu-sandbox.example.com` (throwaway key, env-only, never pasted)
- **Branch:** `feat/agent-execution-layer` (no branch switch, no commits by this lens)
- **Lens:** mutation safety — dry-run must not write, impact must be honest, guards must refuse, executed path must match dry-run
- **Probe tooling:** Node scripts under `/tmp` (never in the repo) spying on `globalThis.fetch` to count/inspect every request; `onAudit` to capture executed-path impact. Baseline: `node scripts/live-smoke.mjs` (40 checks), run before AND after in-session repo fixes.

## Verdict

**The SDK's core mutation-safety promise holds against the live vendor.** Dry-run issued zero non-GET requests on all 94 dry-run-capable mutating primitives (the two bulk deletes each issue exactly one documented GET for the impact floor, no writes). Guards refused or failed before any write; validation throws before any IO; unbounded bulk ops are `POLICY_DENIED` before any IO. Executed-path audit impact is a static, honest constant per primitive and matches the dry-run impact for the same call.

One **HIGH** bug class was live-confirmed (`create()` returned the vendor envelope, `created.id === undefined`) and was **fixed in-repo during this session** (`f4c48c6`); this lens verified both sides of the fix live. Two open findings: a **MEDIUM footgun** (a misplaced `dryRun` in the business-opts object silently EXECUTES the mutation) and a **LOW honesty gap** (60 of 62 `reversible: true` dry-run results never name the compensating path; the harness now treats naming as informational).

All records created by this lens were deleted; final list verified. The three pre-existing companies/websites/groups survive unchanged.

## Findings

| # | Severity | Type | Status | Claim (one line) |
|---|----------|------|--------|------------------|
| F1 | **HIGH** | SDK bug (vendor quirk root cause) | **Fixed in `f4c48c6` (22:59 UTC) — both sides verified live** | `companies.create()` declared `Promise<Company>` but returned the vendor envelope `{company: {...}}`, so `created.id` was `undefined` on the envelope backend |
| F2 | LOW | SDK design gap | Open (harness C22 now treats as informational) | 60 of 62 `reversible: true` dry-run results name no compensating path in checks/warnings |
| F3 | **MEDIUM** | SDK footgun | Open | `procedures.duplicate(id, { company_id, dryRun: true })` (dryRun in the business-opts slot) issues a REAL POST with `dryRun=true` as a query param — the vendor ignores it and the mutation executes |
| F4 | INFO | Test gap | UNVERIFIED live | `assertNotStale`'s post-read no-version-field branch is unreachable in the current registry; tenant has no live records of the no-version types |
| F5 | RESOLVED | (was a mystery, not a finding) | — | The transient `TypeError: Cannot read properties of undefined (reading 'page')` on `matchers.listAll()` was pre-`da9d273` behaviour; this lens captured both sides of that fix |
| F6 | INFO | Vendor quirk | Documented | `GET /matchers` answers **500** (not 400) without `integration_id`; SDK now refuses before IO (`da9d273`) |

---

## 1. Dry-run zero-write proof (all 94 dry-run-capable mutating primitives)

**Method.** One sweep script (`/tmp/probe-dryrun-sweep.mjs`) imported `dist/index.js`, replaced `globalThis.fetch` with a counting spy, and called every dry-run-capable primitive in the 225-op capability registry (94 ops have `dryRun: true`) with `{ dryRun: true }` and dummy ids (`999999999`). `http.ts` calls the global `fetch` at request time (line 374), so the spy sees every request. Bulk bounds used no-match values (far-future datetime, nonexistent title/company) so any floor read measures 0.

**Result: ZERO non-GET requests across all 94 calls.**

- 92 primitives: **0 requests** at all.
- `activity_logs.deleteAll` and `magic_dash.delete`: **exactly 1 GET each** (documented floor measurement through the read-side filter: `GET /activity_logs?start_date=2099-…&page=1&page_size=100`, `GET /magic_dash?title=zzz-no-such&page=1&page_size=100`). No DELETE, no write, no POST.
- `procedures.duplicate` in its correct 3-arg form (`duplicate(id, {company_id}, {dryRun:true})`): **0 requests** (verified separately after the sweep's arg-position slip — see F3).

Full per-primitive table: **Appendix A**. Every row returned a `DryRunResult` with `simulated: true`, `wouldApply: true`, and a well-formed `impact` — none threw, none issued a non-GET.

**Dry-run also fires no audit event** (verified: `onAudit` count 0 after a dry-run create; the dry-run branch returns before `http.request`).

## 2. Dry-run impact honesty

Checked every dry-run `impact` against the task criteria (`reversible` needs a real compensating path; `affected` must not understate a server-computed set; `exact: false` when the count is a lower bound; `scope` single vs bulk correct).

**Honest (verified live):**

| Primitive | impact | Verdict |
|-----------|--------|---------|
| `activity_logs.deleteAll` | `{affected: 0, scope: bulk, reversible: false, exact: false}` | FLOOR from one bounded page, stated as such in warnings ("affected 0 is a FLOOR from ONE bounded page … the server decides the final target set"). Correct: 0 is a lower bound, not an exact count. |
| `magic_dash.delete` | `{affected: 0, scope: bulk, reversible: false, exact: false}` | Same floor discipline. Correct. |
| `magic_dash.updatePositions` | `{affected: 1, scope: bulk, reversible: true, exact: true}` | `affected` = number of `{id, position}` pairs supplied (exact by construction); undo path named in warnings ("undo: call magic_dash.updatePositions again with the previous positions"). Correct. |
| all `*.delete` / `*.deleteById` / `activity_logs.deleteAll` | `reversible: false` | Correct — no undo for deletes. |
| `s3_exports.create` | `reversible: false` + warning "the API exposes no cancel or delete path for it, so this cannot be undone" | Honest and unusually explicit. |
| `public_photos.create` | `reversible: false` + warning "the API exposes no delete path for a public photo, so this create cannot be undone" | Honest. |
| all single-record ops | `{affected: 1, scope: single}` | Correct. |

**Gap — F2 (LOW, open):** **60 of the 62 `reversible: true` results name no compensating path anywhere in `checks`/`warnings`** — the only warning is the default "server-computed fields are not guaranteed by dry-run". Affected: all `*.create` (15), all `*.update` (24), `*.archive`/`*.unarchive` (6), `assets.moveLayout`, `uploads.upload`, `procedures.createFromTemplate`, `photos.create`, `magic_dash.create`, … Full list in Appendix B. Only `procedures.kickoff` and `magic_dash.updatePositions` name their undo.

Consequence for an agent: the pre-write inspection channel says "this is reversible" without saying HOW (for `update`, undo requires the previous values, which the zero-request dry-run never fetches; for `create`, the id to delete only exists after execution). Note: the in-session harness rewrite (C22, `12f0d88`) now asserts the **registry** rule only — a `reversible: true` write op is allowed if its resource has a `delete`/`archive` primitive (or is itself an update) — and explicitly downgraded "names the undo call" to `informational, not a failure` (via `|| true` in the live probe). So the gap is a consciously accepted design position; it remains the lens's only open honesty finding. Suggested fix: emit a warning naming the compensating primitive per op family (e.g. "undo: <resource>.delete(created id)").

## 3. Executed-path parity

**Method.** Created a company (`node-hudu-mut-safety-…`, id 65 on the first run) with `onAudit` capturing every audit event; compared the audit event's `impact` for the executed call with the dry-run `impact` for the same call.

| Op (same call args) | dry-run `impact` | executed audit `impact` | Verdict |
|---------------------|------------------|--------------------------|---------|
| `companies.create({name})` | `{affected: 1, scope: single, reversible: true}` | `{affected: 1, scope: single, reversible: true}` (op `companies.create`, effect `write`, outcome `success`) | **Identical** |
| `companies.update(id, {name}, {expectedUpdatedAt: fresh})` | `{affected: 1, scope: single, reversible: true}` | `{affected: 1, scope: single, reversible: true}` (op `companies.update`, effect `write`) | **Identical** |
| `companies.delete(id)` | `{affected: 1, scope: single, reversible: false}` | `{affected: 1, scope: single, reversible: false}` (effect `destructive`) | **Identical** |

- Executed requests: create = exactly 1 `POST /companies`; guarded update = 1 `GET` (guard read) + 1 `PUT`; delete = exactly 1 `DELETE` (+ the probe's own verification GET → 404).
- The executed `impact` is a **static constant per primitive** (declared once in `base.ts` / the resource and shared by both channels — "One impact statement in both channels"). It is never a fabricated exact number derived from the response; for bulk ops it is a labelled lower bound (Section 6). **No fabrication observed.**
- The executed create audit event carried no key material (C32 territory, re-confirmed by my probe events).

## 4. Guards (`expectedUpdatedAt` / `assertNotStale`)

| Test | Expected | Observed (live) | Verdict |
|------|----------|-----------------|---------|
| `create({name}, {expectedUpdatedAt})` | `HuduConfigError`, no request | `CONFIG_ERROR` "createOne: expectedUpdatedAt is not supported on create/delete/archive …"; **0 requests** | PASS |
| `delete(id, {expectedUpdatedAt})` | `HuduConfigError`, no request | `CONFIG_ERROR` "deleteOne: …"; **0 requests** | PASS |
| `archive(id, {expectedUpdatedAt})` | `HuduConfigError`, no request | `CONFIG_ERROR` "setArchived: …"; **0 requests** | PASS |
| `update(id, {…}, {expectedUpdatedAt: STALE})` | `STALE_OBJECT`, **write must not land** | `StaleObjectError`, code `STALE_OBJECT`, category `conflict`, `retryable: false`, message names both revisions. Requests: exactly 1 `GET /companies/65` (guard read), **no PUT**. Read-back: name unchanged (`writeLanded: false`) | PASS |
| `update(id, {…}, {expectedUpdatedAt: fresh})` | update lands | 1 `GET` + 1 `PUT`; returned record shows the new name; audit impact recorded | PASS |
| `assertNotStale` never fabricates `STALE_OBJECT` for no-version types | `HuduConfigError` (config mismatch, not conflict) | **Source-verified**: `assertNotStale` throws `HuduConfigError` ("carries no updated_at … cannot be verified") when the fetched record has no `updated_at`; `StaleObjectError` only on a real mismatch. **UNVERIFIED live (F4)** — see below | PASS (source) / UNVERIFIED (live) |

**Why F4 is UNVERIFIED live:** the tenant has no live records of any type that lacks `updated_at` — `rack_storage_items`: 0 rows; `public_photos`: 0 rows; `matchers`: requires `integration_id` and the tenant has no integrations (`GET /matchers?integration_id=1|2|3` → `NOT_FOUND "No matching integration"`). Additionally, the current registry makes the post-read branch **unreachable**: every no-version resource (`matchers`, `public_photos`, `rack_storage_items`, `magic_dash`, `s3_exports`, `uploads`) refuses `expectedUpdatedAt` **before any read** via `refuseExpectedUpdatedAtOutsideUpdate` / `refuseGuardOutsideUpdate` (source-verified in each file), so the read-then-config-error path would need a live record that does not exist. The guard contract that IS live-testable (refusal on create/delete/archive, stale → `STALE_OBJECT` + no write, fresh → proceeds) all passed.

## 5. `limit` / `page_size` validation

| Test | Expected | Observed (live) | Requests |
|------|----------|-----------------|----------|
| `companies.search('x', { limit: 101 })` | THROW, not clamp | `HuduConfigError` "limit must be an integer from 1 to 100, got \"101\"" | 0 |
| `companies.search('x', { limit: 0 })` | THROW | `HuduConfigError` "limit must be an integer from 1 to 100, got \"0\"" | 0 |
| `companies.list({ page_size: 0 })` | THROW | `HuduConfigError` "page_size must be a positive integer, got \"0\"" (refused before the first fetch, so the infinite-loop risk is real-guarded) | 0 |
| `companies.list({ page_size: 101 })` | — (not a helper `limit`) | Accepted: `GET /companies?page_size=101&page=1`, vendor honoured it | 1 GET |

The 25-default/100-max rule is the **helper** limit rule (`search`/`resolve`/`findBy*`, `helperLimit` in `agent-layer-helpers.ts`) — it throws, never clamps. `page_size` is a raw vendor pagination parameter: only positivity is validated (0 would loop forever, hence the guard); the vendor accepts 101. That asymmetry is by design (documented in `base.ts` paginationOpts) and matches the task's "must THROW rather than clamp" for `limit`.

## 6. Live bulk deletes — executed path (reasoned, NOT executed)

The two bulk deletes were **not executed** (they would destroy tenant data: `activity_logs` holds the tenant's audit trail; executing would also violate "only delete records you created"). Evidence chain instead:

**`activity_logs.deleteAll({datetime})` (executed):** source (`activity_logs.ts`) shows exactly ONE `http.request` — `DELETE /activity_logs?datetime=…` — with `impact: EXECUTED_BULK_DELETE_IMPACT = {affected: 1, scope: 'bulk', reversible: false, exact: false}`. The comment states the design: the executed call keeps its one-request observable shape; `affected: 1` is a labelled lower bound (`exact: false` = "at least one record; the server computes the real set") instead of a pre-read. The dry-run path was executed live: 1 GET (floor) + 0 writes, `affected: 0` for a far-future bound. **UNVERIFIED: the actual single-request executed path** (would wipe tenant logs).

**`magic_dash.delete({title, company_name})` (executed):** source (`magic_dash.ts`) shows exactly ONE `http.request` — form-urlencoded `DELETE /magic_dash` — with the same `EXECUTED_BULK_DELETE_IMPACT`. Dry-run executed live: 1 GET (title-filtered floor) + 0 writes. **UNVERIFIED: executed path** (would destroy tenant data; the tenant currently has 0 `magic_dash` rows, so an execution would also be a no-op write — but still not executed).

**Refusals (verified live, 0 requests each):**
- `activity_logs.deleteAll({ datetime: '' })` → `POLICY_DENIED` "refuses to run without a datetime bound: an empty datetime would delete the entire activity log".
- `magic_dash.delete({ title: '', company_name: 'x' })` → `POLICY_DENIED` "both title and company_name must be non-empty".
- `magic_dash.updatePositions({ company_id: 3, positions: [] })` → `POLICY_DENIED` "refuses to run without targets".

So a refused guard / unbounded bulk op never half-writes: the refusal happens in-process before any fetch (verified with the fetch spy showing 0 requests).


## Finding F1 (HIGH, fixed in-session) — `create()` returned the vendor envelope on 'raw' resources

**Claim.** `companies.create()` declares `Promise<Company>` but, while the vendor wrapped the POST body, returned the vendor envelope: `await hudu.companies.create({name})` gave `{ company: { … } }` and `created.id === undefined`. An agent following the declared type would get `undefined` for the created record's id and then target the wrong record (or nothing) on update/delete.

**Root cause (SDK).** `companies` (and 20 other resources) construct `BaseResource` with `createType: 'raw'`; `createOne` only unwrapped for `'wrapped'` (`createType === 'wrapped' ? unwrapSingle(body) : body as U`), so it returned whatever the vendor sent, typed as the record. `updateOne` was unaffected because PUT responses are always unwrapped by `singleKey`.

**Root cause (vendor quirk).** The live vendor wraps POST even though the repo's own `api-docs.json` documents the 201 body as the bare record (`$ref Company`) — which is why `'raw'` looked right and why mocked tests (fixtures return what the SDK expects) could never see it. Verified with raw `fetch` (SDK bypassed, `x-api-key` header): **12/12 consecutive `POST /api/v1/companies` returned the `{company: {...}}` envelope** (status 200, nginx), sampled at 00:50 UTC and 00:55 UTC.

**Live evidence, both sides of the fix:**
- Pre-fix dist (harness run 21:05 UTC, check C39): FAIL — "declared Promise<Company> but returned keys [company] -> the vendor envelope".
- Pre-fix dist (this lens, executed create, 22:57 UTC): `returnedKeys: ["company"]`, id extracted from `created.company.id` (id 65).
- Fix `f4c48c6` ("fix(base): unwrap a one-key create envelope that a 'raw' resource still receives", committed 22:59 UTC): the 'raw' create path now unwraps ONLY when the body is exactly a one-key `{singleKey: record}` envelope; a bare record passes through untouched (including a record containing a field merely named like the singleKey); resources without a singleKey are never unwrapped.
- Post-fix dist (this lens, 00:39 / 00:44 / 01:00 UTC): **8 consecutive creates returned proper records** with numeric `id` and full field set (`id, slug, name, …, created_at, updated_at, integrations`) — while raw `fetch` at the same times still shows the vendor envelope, proving the SDK is now normalizing it.
- Fresh harness (01:16 UTC) C39: PASS — "returned a Company with id 102".

**Repro (pre-fix dist only; current dist is fixed):**
```bash
cd /Users/maxs/gitrepos/node-hudu
# with pre-f4c48c6 dist, from a probe script (key via env, never inline):
# const hudu = new HuduClient({ baseUrl: process.env.HUDU_BASE_URL, apiKey: process.env.HUDU_API_KEY });
# const made = await hudu.companies.create({ name: 'probe' });
# console.log(Object.keys(made));      // pre-fix: ["company"]   post-fix: ["id","slug","name",…]
```

**Residual note.** The fix normalizes the one-key envelope for EVERY resource in `base.createOne`, so other 'raw' resources (`articles`, `procedures`, `networks`, …) are covered by construction; their individual POST response shapes were not each sampled live (UNVERIFIED, low risk given the base-level fix).

## Finding F3 (MEDIUM, open) — a misplaced `dryRun` silently EXECUTES the mutation

**Claim.** For the three procedures ops whose signature is `(id, businessOpts, options?)`, passing `dryRun` in the **business-opts slot** sends it as a query parameter on the real request and executes the mutation.

**Live evidence.** `hudu.procedures.duplicate(999999999, { company_id: 3, dryRun: true })` issued:
```
POST /api/v1/procedures/999999999/duplicate?company_id=3&dryRun=true
```
The vendor ignored the unknown `dryRun` param and answered 404 (dummy id) → SDK `NOT_FOUND "Procedure not found"`. With a REAL id the vendor would 200 and return the created duplicate — the caller asked for a dry-run, got an executed mutation's result back, and believes nothing happened. Correct form `duplicate(999999999, { company_id: 3 }, { dryRun: true })` → **0 requests** (verified).

**Blast radius (source-verified):** `procedures.duplicate`, `procedures.kickoff`, `procedures.createFromTemplate` all take `(id, opts, options?)` with `dryRun` in the third slot. The MCP tool manifest correctly separates the two objects (`opts` vs `options`), and TypeScript callers are protected by the types — the exposure is **JS/agent callers** that build one merged options object (exactly how an LLM agent or an MCP-shape-driven caller naturally does it). `updateOne` already defends against the analogous mistake (`looksLikeMutationOptions` refusal when options land in the `query` slot); the business-opts slot has no such defence.

**Suggested fix.** In the three ops, refuse an unknown `dryRun` key inside the business-opts object (throw `HuduConfigError` naming the correct 3rd-argument form), mirroring `looksLikeMutationOptions`.

**Repro (current dist):**
```js
// /tmp/probe-dupfix-repro.mjs — spy on globalThis.fetch, then:
await hudu.procedures.duplicate(999999999, { company_id: 3, dryRun: true });
// observed request: POST /api/v1/procedures/999999999/duplicate?company_id=3&dryRun=true  (a WRITE was issued)
```

## Cleanup verification

Records created by this lens (all via `companies.create`, all deleted with `companies.delete`, 404-verified or vendor-confirmed):

| Run | Company names / ids | Disposition |
|-----|--------------------|-------------|
| executed run 1 (22:57Z) | `node-hudu-mut-safety-1789253821608` (id 65, updated to `…-upd`) | deleted, GET → 404 |
| executed run 2 (00:39Z) | `node-hudu-mut-safety-…` (id 73) | deleted, GET → 404 |
| env-shape probe (00:44Z) | `node-hudu-env-probe-…-{0..3}` (ids 82–85) | deleted, all 404-verified |
| raw-vendor probe (00:50Z) | `node-hudu-raw-probe-…-{0..5}` (ids 86–91) | deleted (vendor 2xx) |
| LB probe (00:55Z, workers A+B) | `node-hudu-lb-probe-…-{0..2}` × 2 | deleted in-probe |
| executed run 3 (~01:00Z) | `node-hudu-mut-safety-…` (id 98) | deleted, GET → 404 |
| dry-run sweep | none (0 non-GET requests; duplicate footgun hit a dummy id → 404, nothing created) | n/a |

**Final list (01:19Z):** 22 companies = the 21 pre-existing (ids 3–23, first three: Microsoft Corporation, Atlassian Corporation, Westpac Banking Corporation — unchanged across every run: `baselineUnchanged: true` in runs 1–3) plus **`ZZ Ambig Probe` (id 71)** — a sibling-lens probe (created 23:48Z, notes: "node-hudu helpers-resolution probe; safe to delete"). It is not this lens's record and was left untouched. `lists`: 1 (matches seed). No `node-hudu-*` names remain.

## UNVERIFIED / could not test

1. **Executed bulk-delete paths** (`activity_logs.deleteAll`, `magic_dash.delete`): reasoned from source (exactly one request each) + live dry-run (one GET floor, zero writes); executing would destroy tenant data — intentionally not executed.
2. **`assertNotStale` post-read no-version branch** (F4): no live records of no-version types exist (tenant has no integrations → no matchers; 0 rack_storage_items; 0 public_photos); source-verified only.
3. **POST response shapes of 'raw' resources other than `companies`**: the base-level one-key-envelope unwrap covers them by construction (F1 fix); only `companies` was create-sampled live.
4. **`activity_logs.deleteAll` floor accuracy**: measured with a far-future bound (floor 0) and a nonexistent title (floor 0); the floor-vs-true-set relationship for a bound that matches real rows was not exercised (would require real matching logs — the harness's C29 did exercise it: `affected: 100` floor with `exact: false` on real data, 0 writes).

## Baseline harness comparison (shared 40-check baseline)

| | First run 21:05Z (stale: pre-fix dist + pre-rewrite harness) | Fresh run 01:16Z (current dist + current harness) |
|---|---|---|
| Result | 34 PASS / 6 FAIL | **40 PASS / 0 FAIL** |
| C07 pagination windows | FAIL "sizes 21/16" | PASS (check rewritten in `12f0d88`) |
| C22 reversible claims | FAIL "claims reversible but names no compensation" | PASS (rule rewritten: registry undo-primitive existence; naming downgraded to informational — see F2) |
| C31 onAudit contract | FAIL (old harness asserted `durationMs`/`status`, which the `AuditEvent` contract does not carry — harness bug, per the check's own comment) | PASS; this lens independently verified one event per call with `correlationId/operation/method/path/effect/dryRun/outcome/timestamp` |
| C33 redact | FAIL | PASS (`ad7be82` masks every credential-key spelling; this lens verified `redact` masks `apiKey/password/token` → `[REDACTED]` and keeps safe fields) |
| C38 registry pagination | FAIL (vendor 500) | PASS (per-operation pagination read, `12f0d88`) |
| C39 create return type | FAIL (envelope) | PASS ("returned a Company with id 102") — the F1 fix |

## Session notes (for the parent)

- The repo moved under this lens: 8 commits landed between 21:08Z and 01:04Z (sibling lenses working the same sandbox), including `ad7be82` (logger masking), `d1efc7f`, `f4c48c6` (create-envelope fix), `da9d273` (matchers integration_id refusal), `41c45bf` (MCP overrides), `12f0d88` (harness rewrite). This lens's probes inadvertently captured **both sides** of `f4c48c6` and `da9d273` (the "mystery" TypeError of run 1 was pre-`da9d273` `matchers.listAll()` forwarding `undefined` params into `paginationOpts`; post-fix it throws a clean named `HuduConfigError` — verified).
- `dist/` is not git-tracked; it was rebuilt by a sibling at 01:01:57Z (after `41c45bf`, before `12f0d88` which only touches `scripts/`). The fresh harness's stale-dist guard passed, so dist matches current src for everything that matters to this lens.
- The API key was passed only via `HUDU_API_KEY`/`HUDU_BASE_URL` env vars; it appears in no file written by this lens (probe scripts live in `/tmp`, report in `.run/live/`).

## Appendix A — 94-primitive dry-run sweep (requests / non-GET / outcome)

| Primitive | Requests | Non-GET | Outcome |
|-----------|----------|---------|---------|
| activity_logs.deleteAll | 1 | 0 | dry-run ok: affected=0, scope=bulk, reversible=False, exact=False |
| articles.archive | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| articles.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| articles.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| articles.unarchive | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| articles.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| asset_layouts.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| asset_layouts.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| asset_passwords.archive | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| asset_passwords.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| asset_passwords.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| asset_passwords.unarchive | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| asset_passwords.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| assets.archive | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| assets.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| assets.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| assets.moveLayout | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| assets.unarchive | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| assets.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| companies.archive | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| companies.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| companies.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| companies.unarchive | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| companies.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| expirations.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| expirations.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| exports.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| flag_types.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| flag_types.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| flag_types.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| flags.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| flags.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| flags.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| folders.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| folders.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| folders.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| ip_addresses.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| ip_addresses.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| ip_addresses.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| label_types.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| label_types.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| label_types.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| labels.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| labels.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| labels.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| lists.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| lists.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| lists.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| magic_dash.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| magic_dash.delete | 1 | 0 | dry-run ok: affected=0, scope=bulk, reversible=False, exact=False |
| magic_dash.deleteById | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| magic_dash.updatePositions | 0 | 0 | dry-run ok: affected=1, scope=bulk, reversible=True, exact=True |
| matchers.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| matchers.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| networks.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| networks.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| networks.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| password_folders.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| password_folders.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| password_folders.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| photos.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| photos.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| photos.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| procedure_tasks.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| procedure_tasks.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| procedure_tasks.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| procedures.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| procedures.createFromTemplate | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| procedures.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| procedures.duplicate | 1 | 1 | THREW NOT_FOUND (probe passed dryRun in the wrong slot — see F3; correct form verified 0 requests) |
| procedures.kickoff | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| procedures.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| public_photos.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| public_photos.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| rack_storage_items.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| rack_storage_items.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| rack_storage_items.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| rack_storages.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| rack_storages.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| rack_storages.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| relations.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| relations.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| s3_exports.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| uploads.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| uploads.upload | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| vlan_zones.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| vlan_zones.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| vlan_zones.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| vlans.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| vlans.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| vlans.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| websites.create | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |
| websites.delete | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=False |
| websites.update | 0 | 0 | dry-run ok: affected=1, scope=single, reversible=True |

Total: 94 primitives, 0 non-GET requests, 0 writes.

## Appendix B — `reversible: true` without a named compensating path (F2)

**Names an undo path (2):** magic_dash.updatePositions, procedures.kickoff

**Does NOT name one (60):**
- articles.archive
- articles.create
- articles.unarchive
- articles.update
- asset_layouts.create
- asset_layouts.update
- asset_passwords.archive
- asset_passwords.create
- asset_passwords.unarchive
- asset_passwords.update
- assets.archive
- assets.create
- assets.moveLayout
- assets.unarchive
- assets.update
- companies.archive
- companies.create
- companies.unarchive
- companies.update
- expirations.update
- flag_types.create
- flag_types.update
- flags.create
- flags.update
- folders.create
- folders.update
- ip_addresses.create
- ip_addresses.update
- label_types.create
- label_types.update
- labels.create
- labels.update
- lists.create
- lists.update
- magic_dash.create
- matchers.update
- networks.create
- networks.update
- password_folders.create
- password_folders.update
- photos.create
- photos.update
- procedure_tasks.create
- procedure_tasks.update
- procedures.create
- procedures.createFromTemplate
- procedures.update
- public_photos.update
- rack_storage_items.create
- rack_storage_items.update
- rack_storages.create
- rack_storages.update
- relations.create
- uploads.upload
- vlan_zones.create
- vlan_zones.update
- vlans.create
- vlans.update
- websites.create
- websites.update

All of the above carry only the default warning `server-computed fields are not guaranteed by dry-run` (or a multipart-validation warning) and checks limited to `target-identifier` / `payload-present` / `file-present`. The compensating primitive exists in the registry for every one of them (which is what the rewritten C22 asserts), but the dry-run output — the agent's only pre-write inspection channel — never says which one to call.

**Representative evidence dumps (live):**

`activity_logs.deleteAll({datetime: '2099-01-01T00:00:00Z'}, {dryRun: true})` → 1 GET, 0 writes:
```json
{"impact": {"affected": 0, "scope": "bulk", "reversible": false, "exact": false},
 "warnings": ["bulk delete by a server-side bound: every activity log from 2099-01-01T00:00:00Z on",
              "affected 0 is a FLOOR from ONE bounded page (page_size 100) read via start_date; the server decides the final target set"]}
```

Stale guard (live):
```
StaleObjectError: Stale object: companies 65 was not at the expected revision for companies.update
(expected updated_at 1999-01-01T00:00:00.000Z, found 2026-09-12T22:57:02.133Z)
code=STALE_OBJECT category=conflict retryable=false | requests: 1 GET (guard read), 0 PUT | read-back: name unchanged
```

Executed create audit event (live, post-fix dist):
```json
{"correlationId": "3591ebc1-…", "operation": "companies.create", "method": "POST", "path": "/companies",
 "effect": "write", "dryRun": false, "outcome": "success",
 "impact": {"affected": 1, "scope": "single", "reversible": true}}
```
(identical to the dry-run impact for the same call — parity holds)

---

## Coordinator verification (added after the report was filed)

| Finding | Verdict | Evidence / action |
|---|---|---|
| Core promise: dry-run writes nothing | **CONFIRMED** | 94 mutating primitives, fetch-spy proven; re-confirmed by the coordinator's own harness (dry-run checks C21/C23/C29 issue zero non-GET requests) |
| F1 companies.create envelope | **CONFIRMED → FIXED** | `f4c48c6`; post-fix harness `C39` PASS (live id 102), and the coordinator saw ids 66/77/81 across runs |
| F2 60/62 reversible claims name no compensating path | **ACCEPTED (informational)** | The registry-level rule (an operation with no delete/archive primitive must not claim reversible) passes; naming the undo call in prose is a documentation improvement, not a correctness gap. Harness C22 now tests the rule that matters. |
| F3 dryRun in the payload slot executes a real write | **CONFIRMED → FIXED** | Extended beyond procedures: the coordinator wired a shared refusal into `createOne`/`updateOne` and into `procedures.duplicate`/`kickoff`/`createFromTemplate` and `assets.moveLayout`. Live: the footgun and its `dry_run` spelling now throw CONFIG_ERROR with **0 requests**; the correct 3-arg form still returns a DryRunResult with 0 requests; ordinary creates unaffected. |
| F4 assertNotStale no-version branch | **UNVERIFIED (accepted)** | No live record type without a version field exists on this tenant; source-verified only. Recorded as an accepted gap. |
| F5 matchers TypeError | **STALE (already fixed)** | `da9d273`; the guard refuses a missing `integration_id` before any IO. |
| F6 GET /matchers 500 without integration_id | **CONFIRMED → FIXED** | `da9d273` |
| Baseline 34/6 → 40/40 on a fresh dist | **CONFIRMED by the coordinator** | the 40/40 run is reproduced after every fix; the harness now REFUSES to run against a stale dist (`12f0d88`) so this cannot be misread again |
