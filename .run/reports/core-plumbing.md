# Core plumbing — agent execution layer (CORE PLUMBING implementer report)

Repo: `/Users/maxs/gitrepos/node-hudu`, branch `feat/agent-execution-layer`.
Policy: `~/.prime/agent/skills/api-node-squad/references/agent-execution-layer.md` §6-§10.
Status: **complete for the owned files**. No commit, no push, no `npm install`, `package.json` untouched.

## 1. Files changed (all additive)

| Path | Lines | Change |
|------|-------|--------|
| `src/types/common.ts` | 200 | NEW — `OperationMetadata`, `OperationEffect`, `OperationFlag`, `FieldDiff`, `DryRunCheck`, `DryRunResult<T>`, `ResolutionCost`, `ResolutionCandidate`, `Resolution<T>`, `AuditEvent`, `Identifier`, `IdentifierObject`, `HelperOptions`, `ResolutionOptions`, `MutationOptions`, and the 5 compact shapes (`CompanySummary`, `AssetSummary`, `ArticleSummary`, `WebsiteSummary`, `AssetPasswordSummary`) |
| `src/errors.ts` | 326 | Extended additively: `category`/`retryable`/`httpStatus`/`vendorError`/`resourceIds`/`suggestedAction`/`correlationId`/`operation`; `status` is now a getter alias of `httpStatus` (single source of truth); `ConflictError` (409 CONFLICT), `StaleObjectError` (412 STALE_OBJECT), `ValidationFailedError` (400 VALIDATION_FAILED), `DuplicateFoundError` (DUPLICATE_FOUND), `ResolutionError` (+ `truncated`/`ambiguous`), `PolicyDeniedError` (POLICY_DENIED); `errorFromStatus` now maps 409/412 and fills category/retryable/suggestedAction per status |
| `src/http.ts` | 535 | Three additions in the ONE transport: one `correlationId` per call (generated before the first attempt, reused across retries, attached to thrown `HuduError`s), the `onAudit` hook (one event per call, success and error path, redacted), and the `dryRun` short-circuit (`DryRunRequest` marker, zero fetch). Plus `resolution`/`concurrency` on `HttpClient` and deadline aborts tagged `category: 'timeout'` |
| `src/resources/base.ts` | 533 | `buildDryRunResult`, `payloadCheck`/`targetCheck`, OVERLOADED `createOne`/`updateOne`/`deleteOne`/`setArchived` with optional `{ dryRun }` / `{ expectedUpdatedAt }`, `boundedScan`, static `requireResolved`, `assertNotStale`, `mapConcurrent`, `concurrency` getter; `getOne`/`pageFetcher` now pass `operation`+`resourceIds` for audit |
| `src/config.ts` | 160 | `resolution?: { maxScanRecords?, maxScanPages? }` (defaults 500/4), `onAudit?`, `concurrency?` (default 4, integer >= 1), all validated with `HuduConfigError`; every existing default unchanged |
| `src/logger.ts` | 75 | Exported `redact(value)` (recursive, returns a copy), `REDACTED`, `REDACTED_KEYS`, `isCredentialKey`; the existing debug/warn behaviour is untouched |
| `src/index.ts` | 50 | ADDITIVE exports only: `redact`, `isCredentialKey`, `REDACTED`, `REDACTED_KEYS`, the 6 new error classes + `ErrorCategory`/`ResolutionErrorCode`/`HuduErrorOptions`, `ResolutionConfig`, `DEFAULT_MAX_SCAN_RECORDS`/`DEFAULT_MAX_SCAN_PAGES`/`DEFAULT_CONCURRENCY`, `DryRunRequest`, `export type * from './types/common.js'`. Nothing reordered or removed |
| `test/core-agent-layer.test.ts` | 829 | NEW — 40 tests, the §11 rows for this plumbing, using `test/helpers.ts` mocked fetch |

## 2. Commands run (exact results)

| Command | Exit | Result |
|---------|------|--------|
| `npx tsc --noEmit` | **0** | clean |
| `npm run lint` | **0** | clean (`eslint src test`) |
| `npm test` | **0** | 17 files, **427 tests passed** |
| `npx vitest run --coverage` | **0** | All files **98.23 stmts / 83.07 branch / 97.42 funcs / 98.29 lines** (thresholds 97/83/94/97) |
| `npx tsc -p tsconfig.test.json --noEmit \| grep -c core-agent-layer` | 0 matches | my test file type-checks clean under the test config (that config still reports **pre-existing** errors in `test/base.test.ts`, `test/http.test.ts`, `test/client.test.ts` — missing vitest globals / read-only `Response.blob`; not mine, not touched) |

Per-file coverage of the owned files: `config.ts` 100/100/100/100 · `logger.ts` 100/100/100/100 · `errors.ts` 99.03/98.91/100/100 · `http.ts` 99.06/95.2/100/98.87 · `base.ts` 99.21/93.33/100/100.
`http.ts` lines 333 and 517 are the two deadline-elapsed guards inside the existing token/deadline logic (pre-existing code, hard to hit deterministically without a flaky timer test).

## 3. Existing tests that changed behaviour

**None.** No existing test file was edited and no existing public signature, return shape, error `code` value or config default changed. `test/errors.test.ts` (22), `test/config.test.ts` (24), `test/http.test.ts` (55), `test/base.test.ts` (6), `test/logger.test.ts` (3), `test/public-surface.test.ts` (6) all pass unmodified, including the `(message, url?, body?)` constructor forms and the `readonly status?: number` reads (`status` is now a getter returning the same value).

Behaviour notes that are additive but observable:
- `err.status` is a prototype getter, so `Object.getOwnPropertyNames(err)` no longer lists `status` (it never listed it as enumerable; `'status' in err` and `err.status` are unchanged).
- The transport now attaches `correlationId`/`operation`/`resourceIds` to thrown `HuduError`s and emits audit events only when `onAudit` is set.
- `HuduNetworkError` now reports `retryable: true` for plain network errors (transient), `category: 'network'`; deadline aborts report `category: 'timeout'`.

## 4. Test rows delivered (`test/core-agent-layer.test.ts`, 40 tests)

dry-run issues ZERO fetch calls for create/update/delete/archive and returns `simulated: true` + its checks (also the failed-check variants and an explicit `diff`/bulk `impact`); the transport-level `dryRun` returns a marker with zero fetch and audits `dryRun: true`; correlation id on the success path, on the error path (same value in `err.correlationId` and the audit event), and one id per call across a retry; `onAudit` receives correlationId/operation/effect/outcome/httpStatus/resourceIds/timestamp and the verb+path-derived fallback names; audit query payloads are redacted while returned data is NOT silently redacted; `redact()`/`isCredentialKey`/`REDACTED_KEYS` behave as documented (nested, arrays, non-plain values, no mutation); bounded scan stops at the first match, at `maxScanRecords`, and at `maxScanPages`, uses the config caps, returns `null` only after a complete scan, never truncates a non-paginated fetch (600 items, `hasMore:false`, cap 10 -> `scanned 600`, `scanTruncated false`, one request), and `requireResolved` turns truncation into `RESOLUTION_TRUNCATED`; stale guard makes no extra request without `expectedUpdatedAt`, reads-then-writes on a match, throws `STALE_OBJECT` before the PUT on a mismatch, and treats an unreadable current record as stale; error contract categories/`retryable`/`httpStatus`/`status`-alias for 400/401/403/404/405/406/409/412/418/422/429/500/503 and every new class code; `mapConcurrent` order + cap + `concurrency` getter.

## 5. Policy-forced trade-offs (deliberate, documented)

1. **Dry-run must issue NO request at all.** The base dry-run therefore runs only local checks (`payload-present`, `target-identifier`) and never fetches. Referenced-resource / duplicate / stale verification in a dry-run must be done by the resource-level builder, which can pass `checks`/`diff` into `buildDryRunResult`. Consequence: `{ dryRun: true, expectedUpdatedAt }` does not run the stale read — the stale guard is a live-path check only.
2. **`boundedScan` examines every record of a fetched page.** This is required by the "nothing already fetched is left unread" rule, so `scanned` can exceed `maxScanRecords` by up to one page, and a NON-paginated fetch is never reported truncated. Truncation is signalled only when a cap stopped the scan while the fetcher still reported `hasMore: true` (per the coordinator's clarification #3).
3. **`updateOne` keeps `query` in the 3rd position** (backwards compatibility), so mutation options there would silently become query parameters on a real write. It is rejected with `HuduConfigError` instead, and the options are the 4th argument. The overload set is: `(id, data)`/`(id, data, query)` -> `U`; `(id, data, query, { dryRun: true })` -> `DryRunResult<U>`; `(id, data, query, { expectedUpdatedAt })` -> `U`; a variable `MutationOptions` -> `U | DryRunResult<U>` (the caller narrows; a conditional return type would be unsound).
4. **`DryRunResult<T>` carries a phantom `__recordType?: T`.** TS `noUnusedLocals` rejects an unused type parameter, so `T` must be used by a member. It is never set at runtime; the §7.2 fields are exactly as specified.
5. **`AuditEvent` has one extra optional field, `query`.** Without it the §11 row "the audit payload carries no credential-shaped value" cannot be exercised: no listed field can hold a credential. The query is stored redacted, and returned data stays untouched. This is the only deviation from the listed AuditEvent fields.
6. **`resolution.allowClientScan?: boolean`** was added to `ResolutionOptions` to give the resources layer the Section-J toggle named by `architecture-template.md`; no resource honours it yet.
7. **`mapConcurrent` was added** (not in the explicit deliverable list) because policy §10 requires a bounded-parallelism helper and no other agent owns `base.ts`. Order-preserving, capped, never unbounded `Promise.all`.
8. **`include`d types only.** `src/types/index.ts` was NOT touched (ownership), so `common.ts` is re-exported from `src/index.ts` via `export type * from './types/common.js'` and resources should import from `../types/common.js` directly.

## 6. Gaps — UNVERIFIED

- `boundedScan`, `requireResolved`, `assertNotStale`, `buildDryRunResult` are exercised only through the test probe subclass. **No real resource calls them yet** (the 35 resource classes are owned by other agents). UNVERIFIED on a real resource path.
- The audit `operation` values derived in `base.ts` (`<resourcePath>.create|update|delete|archive|unarchive|get|list`) must match the registry operation names in `capabilities.plan.json` for tool projection. UNVERIFIED — I did not read the plan.
- `RESOLUTION_AMBIGUOUS` candidate collection: `boundedScan` stops at the first exact match, so ambiguity (multiple matches under a server filter) is the resolve implementation's job; only the `ResolutionError.ambiguous` constructor is provided here. UNVERIFIED end-to-end.
- Dry-run checks for referenced resources (parent company/layout/folder) do NOT exist in the base — resources must pass their own `checks`. UNVERIFIED for the resources that need them.
- `mapConcurrent` is not used by any bulk helper yet (none exists). UNVERIFIED under a real bulk operation.
- The `looksLikeMutationOptions` guard rejects a query bag whose keys are only `dryRun`/`expectedUpdatedAt`; `grep -c "dryRun\|expectedUpdatedAt" api-docs.json` = 0, so no Hudu endpoint collides today. UNVERIFIED against future spec revisions.
- `redact()` treats class instances (Date/Blob/Error) as opaque via a plain-prototype check; a resource returning a class instance with credential fields would not be redacted by that path. UNVERIFIED (no such resource exists today).

---

## 7. Follow-up fixes (coordinator message, after two implementers hit real defects)

**FIX 1 — `expectedUpdatedAt` cannot be a silent no-op.** `createOne`, `deleteOne` and
`setArchived` now throw `HuduConfigError` (`CONFIG_ERROR`, category `validation`, **no request
issued**) when `opts.expectedUpdatedAt` is present, with the message
`"<primitive>: expectedUpdatedAt is not supported on create/delete/archive - it guards update only (updateOne)"`.
The guard runs before the dry-run branch in all three, so a caller who passed both gets the
diagnostic, not a simulated pass. `updateOne` accepts `expectedUpdatedAt` exactly as before.
Implemented once as `protected assertNoExpectedUpdatedAt(primitive, opts)`.

**FIX 2 — `assertNotStale` no longer invents a false conflict.** When the fetched current
record carries no usable version field (`updated_at` undefined / null / empty — e.g.
`rack_storage_items`, `ip_addresses`, `matchers`, `magic_dash`, `uploads`) it throws
`HuduConfigError` (`CONFIG_ERROR`, `validation`, `resourceIds`, `operation`, and a
`suggestedAction` naming `updated_at`) instead of `StaleObjectError`. A real mismatch against a
real `updated_at` still throws `StaleObjectError` (`STALE_OBJECT`). `HuduConfigError` gained an
optional `HuduErrorOptions` argument so it can carry that `suggestedAction` (additive; the
one-argument form is unchanged).

**Also fixed in my lane:** `src/index.ts` — the coordinator's widened summaries plus the types
barrel re-export made my `export type * from './types/common.js'` ambiguous (`TS2308:
CompanySummary`). Replaced with an explicit named `export type { ... }` list of all 20
`common.ts` names (explicit re-exports win over the barrel's star export).

**Tests added:** `expectedUpdatedAt` rejected on create/delete/archive (6 call shapes, ZERO
fetch, `updateOne` still accepted) and a no-version-field `assertNotStale` matrix
(`undefined` record, `{}`, `updated_at: null`, `updated_at: ''`). 41 tests in
`test/core-agent-layer.test.ts`.

**Command results after the fixes**

| Command | Exit | Result |
|---------|------|--------|
| `npx tsc --noEmit` | **0** | clean (after the `src/index.ts` ambiguity fix above) |
| `npx vitest run test/core-agent-layer.test.ts` | **0** | 41 passed |
| `npx eslint src/resources/base.ts src/http.ts src/errors.ts src/config.ts src/logger.ts src/types/common.ts test/core-agent-layer.test.ts` | **0** | clean |
| `npm test` | 1 | **1437 passed, 4 failed** — see below |

**Expected collateral (NOT mine to fix, NOT edited):** four other-agent test files still assert
the pre-fix silent no-op and now fail on FIX 1:
`test/resources/networks.test.ts`, `test/resources/rack_storages.test.ts`,
`test/resources/vlan_zones.test.ts`, `test/resources/vlans.test.ts` — each with the single test
`"does not read before a delete (the stale guard lives on update only)"`, which calls
`delete(id, { expectedUpdatedAt })` and expects it to succeed. Each owner needs to assert
`HuduConfigError` there instead (one line per file). Every other test file passes, including
`test/public-surface.test.ts` (6) and the 116 tests of
`public-surface/errors/config/base/http/logger`.
