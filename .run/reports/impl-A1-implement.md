# impl-A1 — agent-execution-layer retrofit, Group A resources

Scope: `companies`, `articles`, `assets`, `asset_layouts`, `asset_passwords`.
Branch: `feat/agent-execution-layer`. No commit, no push (coordinator commits).

## 1. Files changed

| File | Total lines | Diff (added/removed) | What changed |
|------|-------------|----------------------|--------------|
| `src/resources/companies.ts` | 443 | +386 / -10 | `resolve`, `findByDomain`, `findBySlug`, `search`, `getContext`; dry-run + guard overloads on `create/update/delete/archive/unarchive`; private `resolveRecord` / `byId` / `filterScan` |
| `src/resources/articles.ts` | 370 | +323 / -10 | `resolve`, `findBySlug`, `search`, `getContext`; dry-run overloads on all six writers |
| `src/resources/assets.ts` | 577 | +464 / -18 | `resolve`, `findBySerial`, `search`, `getContext`; hand-rolled dry-run paths on `create/update/delete/archive/unarchive/moveLayout`; `operation` names on every request |
| `src/resources/asset_layouts.ts` | 340 | +216 / -6 | `resolve` (never sends `page_size`); dry-run + guard overloads on `create/update` |
| `src/resources/asset_passwords.ts` | 355 | +310 / -11 | `resolve`, `findBySlug`, `search` (secret-free summaries); dry-run overloads on all six writers |
| `src/types/company.ts` | 106 | +61 | `CompanySummary`, `CompanyIdentifier`, `CompanyContext`, `CompanyContextExpand` |
| `src/types/article.ts` | 74 | +44 | `ArticleSummary`, `ArticleIdentifier`, `ArticleContext`, `ArticleContextExpand` |
| `src/types/asset.ts` | 97 | +55 | `AssetSummary`, `AssetIdentifier`, `AssetContext`, `AssetContextExpand` |
| `src/types/asset_layout.ts` | 58 | +25 | `AssetLayoutSummary`, `AssetLayoutIdentifier` |
| `src/types/asset_password.ts` | 66 | +33 | `AssetPasswordSummary`, `AssetPasswordIdentifier` |
| `test/resources/companies.test.ts` | 703 | +574 / -0 | 69 tests (append) |
| `test/resources/articles.test.ts` | 449 | new file | 48 tests |
| `test/resources/assets.test.ts` | 715 | +514 / -0 | 72 tests (append) |
| `test/resources/asset_layouts.test.ts` | 282 | new file | 27 tests |
| `test/resources/asset_passwords.test.ts` | 437 | new file | 46 tests |

Not touched (as instructed): `src/types/common.ts`, `src/types/index.ts`, `src/resources/base.ts`,
`src/http.ts`, `src/errors.ts`, `src/config.ts`, `src/logger.ts`, `src/index.ts`, `scripts/**`,
`capabilities.plan.json`, `capabilities.json`, `capabilities.schema.json`, `MCP_TOOL_MANIFEST.md`,
`package.json`, `tsup.config.ts`, `vitest.config.ts`, `examples/**`, `.run/**`, README/CHANGELOG/docs.
No threshold lowered, no test skipped, no `--no-verify`, no generated file edited, no shared script run.

## 2. Commands run (exact) with exit codes

| Command | Exit | Result |
|---------|------|--------|
| `npx tsc --noEmit` | 0 | clean project-wide (earlier runs reported 2 errors in `src/resources/procedures.ts:297` and `src/types/procedure.ts:90` — impl-C files, since fixed by their owner) |
| `npx eslint src/resources/{companies,articles,assets,asset_layouts,asset_passwords}.ts src/types/{company,article,asset,asset_layout,asset_password}.ts test/resources/{companies,articles,assets,asset_layouts,asset_passwords}.test.ts` | 0 | no output (clean) |
| `npx vitest run test/resources/companies.test.ts test/resources/articles.test.ts test/resources/assets.test.ts test/resources/asset_layouts.test.ts test/resources/asset_passwords.test.ts` | 0 | **262 tests passed** (5 files) |
| `npx vitest run test/resources/crud-resources.test.ts test/resources/special.test.ts test/pagination.test.ts test/client.test.ts` | 0 | 219 tests passed — the pre-existing suite covering my resources is unbroken |
| `npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=/tmp/covA4 <my 5 test files>` | 0 | per-file coverage, see §5 (report written to `/tmp`, no repo file touched) |

## 3. Plan test titles

**All 193 plan test rows for my 35 primitive rows + 17 helper rows are implemented; 0 missing.**
Verified mechanically: for every row in `capabilities.plan.json` whose `helper`/`primitive` starts with
one of my five resources, the exact `title` string was searched in the target test file
(`missing plan titles: 0 []`).

Acted on the coordinator ruling (2026-09-12, second steer): `staleCheck: updated_at` + the
`<primitive>.stale` test row now exist only on `<res>.update`. I re-read my rows and removed the
stale test blocks from `companies.create`, `companies.delete`, `articles.create`, `articles.delete`,
`asset_layouts.create`, `asset_passwords.create`, `asset_passwords.delete` (7 blocks) and re-ran my
files. The guard is asserted only on the four `<res>.update` paths (read-then-compare; mismatch ->
`STALE_OBJECT`, `retryable: false`, and **no** PUT is issued).

## 4. Behaviour delivered (per resource)

* `resolve` overloads: default -> compact summary; `{ expand: true }` -> full record;
  `{ resolutionDetails: true }` -> `Resolution<T>` (cost/scanned/scanTruncated/candidates).
  `{ id }` miss throws `NOT_FOUND` (never `null`); `null` only after a **complete** scan; a cap that
  stopped the scan throws `RESOLUTION_TRUNCATED`; several matches throw `RESOLUTION_AMBIGUOUS` with
  candidate ids in `resourceIds`; an unsupported identifier kind throws `HuduConfigError`
  (`CONFIG_ERROR`, category `validation`) naming the accepted kinds. Special cases:
  `assets.resolve({ companyId, id })` = direct company-scoped fetch, bare id = account-wide
  `GET /assets?id=`; `asset_layouts.resolve` reads one page and never sends `page_size`.
* `findByDomain` (companies, vendor `website` + exact host compare), `findBySlug`
  (companies, articles, asset_passwords), `findBySerial` (assets, vendor `primary_serial`).
* `search(q, { limit })`: one bounded request, `page_size = limit`, default 25, hard max 100
  (`HuduConfigError` above it), optional `company_id` narrowing.
* `getContext`: `companies` (company + bounded assets/articles/websites/assetPasswords),
  `articles` (article + company + folder; a 404 related record is `null`, any other error propagates),
  `assets` (asset + layout + expirations + relations). Every sub-list is a bounded fetch that stops at
  `limit`; no sub-fetch uses `listAll`.
* Every scan goes through `BaseResource.boundedScan`; no unbounded scan and no unbounded
  `Promise.all`. Every mutating path accepts `{ dryRun: true }`, returns `DryRunResult` with
  `simulated: true` and issues **no** mutating request. `asset_passwords` helpers return
  `AssetPasswordSummary`, which drops `password`/`otp_secret` (not blanked); `get`/`expand: true` still
  return the secret, and returned data is never redacted implicitly.

## 5. Coverage of my five resource files (own test files only)

| File | Stmts | Branch | Funcs | Uncovered |
|------|-------|--------|-------|-----------|
| `src/resources/companies.ts` | 100.0 | 95.2 | 100.0 | — |
| `src/resources/articles.ts` | 100.0 | 90.0 | 100.0 | — |
| `src/resources/assets.ts` | 100.0 | 91.1 | 100.0 | — |
| `src/resources/asset_layouts.ts` | 99.1 | 90.1 | 100.0 | line 292 (`MAX_PAGES` runaway guard, unreachable in a test) |
| `src/resources/asset_passwords.ts` | 100.0 | 92.9 | 100.0 | — |

## 6. Gaps and blockers

### 6.1 TOOLING BLOCKER — `outputSchema.drops` cannot be derived for any overloaded helper (needs a `scripts/` fix)
`scripts/generate-capabilities.mjs` records **one** method entry per name in source order
(`methods.set(name, ...)`, line 190, unconditional), so the **last** declaration wins — and TypeScript
forces the *implementation* signature last (`TS2391: Function implementation is missing or not
immediately following the declaration`, reproduced with `npx tsc /tmp/ov.ts`). For every helper the
implementation's declared return type is therefore the union
(`CompanySummary | Company | null | Resolution<CompanySummary>`), and `outputSchema(row, method)`
(~lines 320-345) does `resolveProps(rt)`, which resolves neither a union nor `unknown` -> `null` ->
`dropsUnresolved: true` and `drops: []`. `scripts/check-capabilities.mjs` line 352 then fails rule
`helper-compact-drops` ("must name the fields it drops") for **every** helper row that carries a
`compact` value — 17 of my rows, and every other group's helper rows with a compact shape.
Suggested fix (coordinator owns `scripts/`): keep all overload declarations per method name (an array)
and pick the member whose return type `resolveProps` can resolve, i.e. the `{ expand: true }` overload
that returns the full record type; then `drops = fullProps - compactProps` is exactly the documented
list (verified by hand for all five shapes: my compact interfaces keep exactly the design-doc fields
and the derived drops equal the design-doc drop lists).
**UNVERIFIED**: I did not run `capabilities:build` / `capabilities:check` (forbidden), so this is a
source-reading conclusion, not an observed gate output.

### 6.2 `src/types/common.ts` still declares the five compact summaries (duplicate/ambiguous exports)
SCOPING decision 6 (updated 2026-09-12 23:27) places each summary in its own resource type file; I
declared `CompanySummary`, `ArticleSummary`, `AssetSummary`, `AssetLayoutSummary`,
`AssetPasswordSummary` there (`src/types/company.ts` etc.), as the coordinator's steer requires.
`src/types/common.ts` still declares `CompanySummary`, `AssetSummary`, `ArticleSummary`,
`WebsiteSummary`, `AssetPasswordSummary` and `src/index.ts:35` does
`export type * from './types/common.js'`. When the coordinator adds my exports to
`src/types/index.ts`, an ambiguity (`TS2308`) is likely for those five names. Action for the
coordinator: delete the five compact summaries from `common.ts` (or re-export one side explicitly).
They also differ in shape: `common.ts`'s `CompanySummary` lacks `website`, `phone_number`, `city`,
`state`, `id_number`, `updated_at` and keeps `company_type`, which the Group A design doc says to drop.
**UNVERIFIED**: I have not run `tsc` with the barrel entries added, since that file is not mine.

### 6.3 `assets.update` keeps the hand-rolled PUT, `staleCheck: "unavailable"`
Routing it through `updateOne` is not safe: `AssetsResource.resourcePath` is the template
`'companies/{companyId}/assets'`, so `updateOne` would build a broken path, and the vendor PUT returns
a **flat** `Asset` while `createType` is `'raw'`. Two existing tests pin that behaviour
(`test/resources/assets.test.ts:67` "update (raw) returns raw body as-is", `:115` "update wraps the
body in { asset } while moveLayout keeps its own shape"). Consequence: the plan title
"unwraps the PUT response by singleKey" for `assets.update` is satisfied only in the flat
pass-through sense (my test asserts that, with a comment). No `{ expectedUpdatedAt }` guard is offered
on assets, matching `staleCheck: "unavailable"`.

### 6.4 Plan title vs vendor reality for `asset_layouts.list`
"sends page/page_size and stops on a short page" cannot be true literally: `GET /asset_layouts`
accepts `page`, `name`, `slug`, `active`, `updated_at` but **not** `page_size` (documented in the
resource since R1). My test keeps the exact title and asserts `page=1` present, `page_size` absent,
and a stop on a short page.

### 6.5 Cross-owner observations (UNVERIFIED)
* `assets.getContext` delegates to `ExpirationsResource` / `RelationsResource`, whose `listKey` is
  `undefined`; `unwrapList(body, undefined)` returns the body unchanged, so those lists need a bare
  array body. My tests stub arrays. Whether the live vendor envelope (`{ expirations: [...] }`) is
  handled belongs to those resources' owners — my `getContext` does not change if they set `listKey`.
* `companies.getContext` returns the `websites` sub-list as full `Website` records, because
  `websites` is impl-A2's resource and I do not import a `WebsiteSummary` that may not exist yet
  (`src/types/website.ts` changed under me during this run). If impl-A2 lands `WebsiteSummary`, the
  context type can be narrowed — a coordinator decision, it crosses ownership.
* `asset_layouts.filterScan` never reports `scanTruncated` (single page, `hasMore: false`) and its
  100k-page runaway guard is untestable: 1 uncovered statement (line 292).

### 6.6 Not run (out of my scope)
`npm test`, `npm run test:coverage`, `npm run capabilities:build`, `npm run capabilities:check`,
`npm run build`, `npm pack`, `node scripts/*.mjs`. Project-wide red from other implementers' in-flight
files is not attributable to me: only my five test files were run, plus the four pre-existing
test files that cover my resources (all green).
