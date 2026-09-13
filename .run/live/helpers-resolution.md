# Live test: agent-facing helper tier (helpers-resolution lens)

Tenant: Hudu 2.45.1 sandbox (hudu-sandbox.example.com). Branch: feat/agent-execution-layer (HEAD f0bfb6b, dist rebuilt from source).
Scope: `resolve`, `findBySlug`, `findByDomain`, `search`, `getContext`, `listAll`, `listPages`,
compact vs `expand: true`, `operations.searchAcrossResources`, `operations.resolveAny`,
pagination without vendor `meta`, non-paginated endpoints, resolution caps.

Credentials passed via env (`HUDU_BASE_URL`, `HUDU_API_KEY`); never written to this file or the repo.

## Findings

| # | Severity | Type | Claim | Status |
|---|----------|------|-------|--------|
| F1 | CRITICAL | SDK bug | A cap-truncated scan returns a match with `scanTruncated: false` (a false uniqueness claim) instead of throwing `RESOLUTION_TRUNCATED` | VERIFIED-live |
| F2 | HIGH | SDK bug + vendor quirk | `get()` / `resolve({id})` return `null` or a raw `TypeError` for a missing id on 5 resources, because the vendor answers `200 + null` (not 404) and the SDK does not normalise it to `NOT_FOUND` | VERIFIED-live |
| F3 | MEDIUM | SDK design | One failing resource aborts the whole cross-resource search: no transport-error isolation in `searchAcrossResources`; `resolveAny` isolates only resolution errors | VERIFIED-live |
| F4 | MEDIUM | SDK bug | `users.resolve(undefined)` throws a raw `TypeError`; `companies.resolve(undefined)` throws a clean `CONFIG_ERROR` — inconsistent identifier validation | VERIFIED-live |
| F5 | LOW | harness-test gap | Shared-harness C38 conflates operation-level and resource-level pagination, so it fails on a correct registry | VERIFIED-live |

Everything else in scope behaved as documented (see sections 2–9).

## Findings (detail)

### F1 — CRITICAL — SDK bug — truncated scan returns a match with `scanTruncated: false`

**Claim.** When a bounded resolution scan is stopped by `maxScanPages`/`maxScanRecords` and exactly one exact match was seen inside the truncated window, the helper returns that match with `scanTruncated: false` — a false claim of a complete, unique resolution — instead of throwing `RESOLUTION_TRUNCATED`.

**Why it is a lie.** The `Resolution` type documents: "`value: null` is reserved for 'a complete scan found nothing'; a capped scan reports `scanTruncated: true` instead." The QA contract (BACKFILL-HANDOVER.md) says "throw `RESOLUTION_TRUNCATED` at the cap." Returning a match with `scanTruncated: false` from a capped scan violates both: the scan *was* truncated, and uniqueness is *not* established (a second exact match may sit beyond the cap).

**Exact repro (VERIFIED-live).**
```js
// 1. two companies sharing a website (vendor allows duplicate websites)
await hudu.companies.create({ name: 'ZZ Dup Website Probe', website: 'https://www.microsoft.com' }); // id 72
// 2. a client whose page cap is 1
const capped = new HuduClient({ baseUrl, apiKey, resolution: { maxScanPages: 1 } });
// 3. resolve by that domain, page size 1
await capped.companies.findByDomain('https://www.microsoft.com', { limit: 1 });
```
**Observed.** Returns company id 3 (the first match) with `scanTruncated: false` — instead of throwing `RESOLUTION_AMBIGUOUS` (as the default-cap client does: `resourceIds: [3, 72]`) or `RESOLUTION_TRUNCATED`. The same false return occurs with `resolution: { maxScanRecords: 1 }`.

**Root cause.** In `companies.ts filterScan` (and the equivalent `decideScan`/`scanExact` in websites, groups, users, articles, asset_layouts, assets, asset_passwords, folders, password_folders, labels, lists, photos), the one-match branch returns before the `scan.scanTruncated` check:
```ts
if (exact.length === 1) return { value: only, scanTruncated: false, ... };  // <- returns first
if (scan.scanTruncated) throw ResolutionError.truncated(...);               // <- only reached on 0 matches
```
The two-pass resources force `scanTruncated: resolution.value === null && resolution.scanTruncated` in `scanExact`, which has the same effect.

**Reachability.** Default caps bound a scan at 100 records, so with defaults the vendor filter must return >100 rows with the 2nd exact match beyond row 100 (large tenant). With a small `limit` (page size) or a small cap it is trivial to hit — both are normal agent behaviour.

**Suggested fix.** In the one-match branch, check `scan.scanTruncated` first: if the scan was capped, throw `RESOLUTION_TRUNCATED` (matching the documented contract) — or at minimum return the match with `scanTruncated: true` so the caller can see the resolution is not guaranteed unique.

---

### F2 — HIGH — SDK bug + vendor quirk — missing id returns `null`/`TypeError` on 5 resources

**Claim.** `get()` and `resolve({id})` do not throw `NOT_FOUND` for a missing id on `articles`, `asset_layouts`, `asset_passwords`, `folders`, and `websites`, because the vendor answers `200` with body `null` (not 404) for those five and the SDK does not normalise that to `NOT_FOUND`.

**Vendor quirk (VERIFIED-live).** `GET /api/v1/{articles,asset_layouts,asset_passwords,folders,websites}/99999999` → `200` + body `null`. Every other probed resource (companies, groups, lists, users, assets, …) correctly returns `404`.

**SDK bug (VERIFIED-live).**
```js
await hudu.websites.get(99999999);        // -> null   (declared Promise<Website>)
await hudu.websites.resolve(99999999);    // -> null   (contract: id miss throws NOT_FOUND, never null)
await hudu.assetLayouts.get(99999999);    // -> null
await hudu.assetLayouts.resolve(99999999);// -> TypeError: Cannot read properties of null (reading 'id')
```
`websites.resolve` returning `null` for an id miss directly violates the documented "a miss on `{id}` throws `NOT_FOUND` (never null)" contract; `asset_layouts.resolve` crashes with a raw `TypeError` instead of a clean error.

**Root cause.** `BaseResource.getOne` → `unwrapSingle` returns the (null) body for a 200 response without treating an empty body as a miss; `byId` then dereferences `record.id`.

**Suggested fix.** In `getOne`/`unwrapSingle`, treat a `200` response whose unwrapped body is `null`/empty as a miss and throw `NotFoundError` (with the id in `resourceIds`). This normalises the vendor's inconsistent 404-vs-200+null behaviour at the one choke point and fixes all five resources at once.

---

### F3 — MEDIUM — SDK design — one failing resource aborts the whole cross-resource search

**Claim.** `searchAcrossResources` has no per-resource error isolation; `resolveAny` isolates only resolution errors. A transport error (500, network) from any one resource rejects the entire call.

**Exact repro (VERIFIED-live).** Wrap `globalThis.fetch` to return `500` for `/api/v1/users`, then:
```js
await ops.searchAcrossResources('Microsoft', { limit: 2 }); // -> rejects ServerError (SERVER_ERROR)
await ops.resolveAny('Microsoft Corporation');              // -> rejects ServerError (SERVER_ERROR)
```
**Observed.** Both reject with the injected 500; no partial result is returned. With the spy removed, both succeed again.

**Assessment.** All-or-nothing, not a silent lie (a failure throws rather than reporting "no match"). But for an agent, one flaky or vendor-broken resource (e.g. the matchers 500 without `integration_id`) makes the whole cross-resource search/resolve unavailable.

**Suggested fix.** Collect per-resource errors in `boundedMap` and surface them in the result (e.g. a `failed: [{ resource, error }]` field) instead of rejecting the whole call — or explicitly document the all-or-nothing semantics.

---

### F4 — MEDIUM — SDK bug — `users.resolve(undefined)` throws a raw `TypeError`

**Claim.** Passing `undefined` (or a non-identifier) to `resolve` throws a raw `TypeError` on some resources but a clean `CONFIG_ERROR` on others.

**Exact repro (VERIFIED-live).**
```js
await hudu.users.resolve(undefined);     // -> TypeError: Cannot read properties of undefined (reading 'id')
await hudu.companies.resolve(undefined); // -> HuduConfigError (CONFIG_ERROR) naming the accepted kinds
```
**Suggested fix.** Validate the identifier up front in each resource's `resolveRecord` (or in a shared helper) and throw `HuduConfigError` with the accepted-kinds message, matching `companies`.

---

### F5 — LOW — harness-test gap — C38 conflates operation- and resource-level pagination

**Claim.** The shared harness check C38 (`registry pagination mode matches the live endpoint`) fails because it builds the "non-paginated resources" set from *any* registry record with `pagination.nonPaginated` — which includes non-list operations (`companies.get`, `companies.search`, …) on paginated resources — then asserts those resources' list endpoints send no page params.

**Why the registry is right.** `nonPaginated` is marked per *operation*: only list operations (`*.list`/`*.listAll`) are paginated; `companies.get`/`companies.search` are correctly `nonPaginated` even though `companies.list` is paginated. A live fetch spy confirms all 9 genuinely non-paginated endpoints send no `page`/`page_size`.

**Suggested fix.** In C38, filter the registry to records whose name ends in `.list` (or `.listAll`) before deriving the non-paginated resource set.

---

## 1. Baseline harness (scripts/live-smoke.mjs, 40 checks)

Command:
```
HUDU_BASE_URL=... HUDU_API_KEY=... node scripts/live-smoke.mjs --json /tmp/helpers-resolution-baseline2.json
```

Result: **39 PASS / 1 FAIL / 0 SKIP** (after `npm run build` to test current source).

- The single failure is **C38** (`registry pagination mode matches the live endpoint`) — see F5. It is a harness/test gap, not an SDK defect.
- Note: the branch advanced under this session (0d6c756 → f0bfb6b) with `f4c48c6 fix(base): unwrap a one-key create envelope…`. The prebuilt `dist/` was stale; after `npm run build`, **C39** (`create() honours its declared return type`) now PASSES (returns a `Company` with an id). The create-envelope bug is already reported by the envelope-sweep lens (F1 there); not re-derived here.

## 2. resolve() — by id / name / slug / domain

Resources with rows: companies (21), asset_layouts (4), websites (2), groups (1), users (1), lists (1), activity_logs (466), articles (4).

| Resource | by id (hit) | by id (miss) | by name (hit) | by name (miss) | findBy* |
|----------|-------------|--------------|---------------|----------------|---------|
| companies | id 3, cost `server-filter` | `NOT_FOUND` (vendor 404) | id 3, `scanned:1`, `scanTruncated:false` | `null`, `scanTruncated:false` (complete scan) | `findBySlug`→3, `findByDomain`→3, absent→`null` |
| websites | id 1 | **`null`** (see F2) | id 1 | `null` | `findBySlug`→1 |
| groups | id 1 | `NOT_FOUND` | id 1, `scanned:2` (slug-then-name fallback) | `null` | — |
| users | id 1 | `NOT_FOUND` | n/a (user has no `name`) | `null` | `findByEmail`→1 |
| asset_layouts | id 1 | **`TypeError`** (see F2) | id 1 | `null` | — |
| lists | id 1 | `NOT_FOUND` | id 1, `scanned:2` | `null` | `findByName`→1 |
| activity_logs | id 1, cost `client-scan`, `scanned:1` | **`RESOLUTION_TRUNCATED`** (466 rows > 100 cap) | — | — | `findByResource` |

Verified-correct behaviour:
- **id miss → `NOT_FOUND`, never `null`** — holds for every resource whose vendor `GET /{res}/{id}` returns 404 (companies, groups, users, lists, …). The two exceptions are F2 (websites, asset_layouts, +3 more).
- **name miss → `null` only after a complete scan** (`scanTruncated: false`, `scanned` = rows examined). Confirmed for companies, websites, groups, users, asset_layouts, lists.
- **`resolutionDetails: true`** returns `{ value, resolutionCost, scanned, scanTruncated, candidates }`; a hit carries one candidate with a human label (e.g. `Microsoft Corporation (slug acfb95709acd, id 3)`).
- **numeric-string id** (`resolve("3")`) takes the direct-id path (returns id 3).
- **bad identifier kind** (`resolve({ external_id: 'x' })`, `resolve("   ")`) → `CONFIG_ERROR` naming the accepted kinds (companies).
- **`activity_logs`** has no vendor `GET /{id}`; an id is resolved by a bounded client scan. On this tenant (466 logs) a *missing* id scan hits the 100-record cap and correctly throws `RESOLUTION_TRUNCATED` (honest — it cannot decide). A *present* id on page 1 resolves with `cost: client-scan`.
- `groups`/`lists` report `scanned: 2` on a name hit because the bare-value path tries a slug scan then a name scan and sums the cost. Not a bug.

## 3. Ambiguity construction (RESOLUTION_AMBIGUOUS)

The vendor **enforces unique company names** (`POST /companies` with a taken name → `422 "Name has already been taken"`), so company-name ambiguity cannot be constructed. Two other routes work:

**(a) Duplicate website on companies** (vendor allows two companies to share a `website`):
```
created = await hudu.companies.create({ name: 'ZZ Dup Website Probe', website: 'https://www.microsoft.com' })  // id 72
await hudu.companies.findByDomain('https://www.microsoft.com')
```
Observed:
```
_ResolutionError: companies.findByDomain: 2 companies match the identifier exactly, so it is not unique.
code: RESOLUTION_AMBIGUOUS, resourceIds: [3, 72]
suggestedAction: Pass { id } or an exact server-side filter, or choose one of the candidate ids in resourceIds.
```
`companies.resolve({ domain })` throws the same. `operations.resolveAny('https://www.microsoft.com')` returns both as candidates: `[{resource:'companies',id:3,label:'#3',item:null},{resource:'companies',id:72,label:'#72',item:null}]`.

**(b) Duplicate article name** (articles are company-scoped; the vendor allows duplicate names):
```
a1 = await hudu.articles.create({ name: 'ZZ Dup Article Probe', content: '…', company_id: <cid> })  // id 23
a2 = await hudu.articles.create({ name: 'ZZ Dup Article Probe', content: '…', company_id: <cid> })  // id 24
await hudu.articles.resolve('ZZ Dup Article Probe')
```
Observed: `RESOLUTION_AMBIGUOUS`, `resourceIds: [23, 24]` — for both the bare name and the scoped `{ name, company_id }` form.

All constructed records were deleted (section 9).

## 4. Compact vs expand: true

Helper-tier `resolve(id)` returns the compact shape by default; `resolve(id, { expand: true })` returns the full record. Key-set diff (expanded − compact = fields the compact shape drops):

| Resource | compact keys | expanded keys | dropped by compact |
|----------|--------------|---------------|--------------------|
| companies | 12 | 27 | address_line_1/2, company_type, country_name, created_at, fax_number, full_url, integrations, knowledge_base_url, notes, object_type, parent_company_id/name, passwords_url, zip |
| websites | 10 | 33 | account_id, asset_field_id, asset_type, cloudflare_details, code, disable_dns/ssl/whois, discarded_at, enable_*_tracking, headers, icon, keyword, message, monitor_type, monitored_at, notes, object_type, potentially_proxied, refreshed_at, sent_notifications |
| groups | 6 | 9 | created_at, members, url |
| users | 9 | 21 | accepted_invite, created_at, currently_signed_in, last_sign_in_at/ip, otp_required_for_login, phone_number, score_30/90/all_time, sign_in_count, time_zone |
| asset_layouts | 6 | 16 | created_at, fields, icon_color, include_comments/files/passwords/photos, location, sidebar_folder_id, updated_at |
| lists | 5 | 5 | *(none — intentional: the plan records no compact shape for lists)* |

Compact is always a strict subset (no `compactOnly` keys). `expand: true` on `searchAcrossResources` returns full records (e.g. 27 keys for a company).

## 5. operations.searchAcrossResources / resolveAny

`searchAcrossResources('Microsoft', { limit: 3 })` → 1 hit: `{ resource:'companies', id:3, label:'Microsoft Corporation' }`. The 8 searchable resources are companies, articles, assets, websites, asset_passwords, password_folders, groups, users — `lists`/`asset_layouts` are **not** searched, so `searchAcrossResources('Computer')` → 0 hits even though a list and an asset_layout are named "Computer …". `expand: true` returns full records. An unknown resource name (`{ resources: ['nope'] }`) → `CONFIG_ERROR` naming the supported set.

`resolveAny` returns `{ hits, truncated, scanned }`; an ambiguous identifier becomes candidate hits (section 3a) instead of throwing.

**Failure isolation (F3).** The fan-out runs at `concurrency` (default 4) via `boundedMap`, which has **no per-resource error isolation**. Injecting a `500` on `/users` with a `globalThis.fetch` spy:
```
ops.searchAcrossResources('Microsoft', { limit: 2 })  // users 500
  -> rejects: ServerError: Injected 500 for probe   (code SERVER_ERROR)
ops.resolveAny('Microsoft Corporation')               // users 500
  -> rejects: ServerError: Injected 500 for probe   (code SERVER_ERROR)
```
So **one failing resource aborts the whole call** for both helpers. `resolveAny` isolates only resolution-specific errors (`RESOLUTION_TRUNCATED` → `truncated`, `RESOLUTION_AMBIGUOUS` → candidates, `NOT_FOUND` → no hits); any transport error (`500`, network) propagates and rejects the entire call. This is all-or-nothing, not a silent lie (a failure throws rather than reporting "no match"), but a single flaky resource makes the whole cross-resource search unavailable.

## 6. Pagination (listAll beyond page 1, no vendor `meta`)

The vendor sends **no `meta`** block. `listAll` derives `hasMore` from the returned row count (`rows.length === page_size`) and walks pages until a short/empty page. Verified: `companies.listAll({ page_size: 5 })` → 5 page calls, 21 unique rows (no duplicates, none missing). `listPages` yields 5-row windows. The SDK's pagination is correct in the absence of vendor `meta`.

## 7. Non-paginated endpoints (no page/page_size)

A `globalThis.fetch` spy counted query params on every request. All 9 genuinely non-paginated endpoints (e.g. `companies.get`, `companies.search`, `api_info`, `magic_dash`, …) send **no** `page`/`page_size`. The registry marks `nonPaginated` per *operation* (correct); the C38 harness check misreads it at the *resource* level (F5).

## 8. Resolution caps (maxScanPages / maxScanRecords)

Defaults: `maxScanRecords: 500`, `maxScanPages: 4`; `SCAN_PAGE_SIZE = 25`, so the effective default cap is **100 records** (the page cap binds first — confirmed by the `activity_logs` miss: "stopped after 100 record(s)").

The caps **do** bound a scan (the walk stops at the cap). But see **F1**: when the capped scan has already seen one exact match, the helper returns that match with `scanTruncated: false` instead of throwing `RESOLUTION_TRUNCATED`.

## 9. Cleanup verification

Every record created by this lens was deleted and re-listed:
- companies: back to **21** (baseline); 0 `ZZ*` strays. (A `ZZ Ambig Probe` company, id 71, left by an earlier crashed probe was found and deleted.)
- articles: back to **4**; 0 `ZZ*` strays.
- websites: **2** (unchanged: google.com, democorp.com.au). groups: **1** (Default Group).
- Pre-existing companies 3/4/5 (Microsoft, Atlassian, Westpac) intact.
- `activity_logs.deleteAll` / `magic_dash.delete` were **not** called (only `{dryRun:true}` is permitted, and neither was needed).

## 10. Could not test (UNVERIFIED)

- **F1 on the two-pass resources (groups, folders, password_folders, labels, users, lists, photos)** — code-verified only (same `scanTruncated: false`-on-match pattern in `scanExact`/`decideScan`), but the tenant has ≤1 row for each and no create path, so a live ambiguity could not be constructed there. The collect-all resources (companies, websites, articles, asset_layouts, assets, asset_passwords) are live-verified.
- **F2 on articles, asset_passwords, folders** — the vendor `200 + null` is live-verified for all five, but the SDK `get()`/`resolve()` null/TypeError was only exercised on websites and asset_layouts (the other three share the identical `getOne`/`byId` code path).
- **`getContext` beyond key-set** — `companies.getContext(id, { limit: 2 })` returns the documented keys; deeper content correctness was not asserted.
