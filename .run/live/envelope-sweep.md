# Envelope Sweep — response-envelope correctness across all 35 resources

**Lens:** response-envelope correctness (the bug class behind the groups/users/websites `listKey: undefined` defect).
**Tenant:** Hudu 2.45.1 sandbox (intellectitdev). **Branch:** feat/agent-execution-layer. **Date:** 2026-09-12.
**Method:** raw `fetch` against `/api/v1/...` (true vendor body) + SDK calls through `dist/`, compared against the
`singleKey` / `listKey` / `createType` each resource declares in `src/resources/*.ts`.
**Baseline harness** (`scripts/live-smoke.mjs`, 40 checks): **34 PASS / 6 FAIL / 0 SKIP** (see §Baseline).

> **Headline:** the `listKey` fix (commit 5c79bf9) held — every list/get envelope now matches. But the SAME bug
> class survives on the **create** path for **3 resources**: `companies`, `articles`, `procedures` declare
> `createType: 'raw'` while the live vendor wraps the POST/PUT body in `{singleKey: record}`. The SDK therefore
> hands back the **envelope**, not the declared record type. `update()` is unaffected (the base class always
> unwraps PUT by `singleKey`); only `create()` is broken.

## Findings (summary table)

| # | Severity | Class | Resource | One-line claim |
|---|----------|-------|----------|----------------|
| F1 | **HIGH** | SDK bug | `companies` | `create()` returns `{company:{…}}` envelope, declared `Promise<Company>` — `createType` should be `'wrapped'`. |
| F2 | **MED-HIGH** | SDK bug | `articles` | `create()` returns `{article:{…}}` envelope, declared `Promise<Article>` — `createType` should be `'wrapped'`. |
| F3 | **MED** | SDK bug | `procedures` | `create()` returns `{procedure:{…}}` envelope, declared `Promise<Procedure>` — `createType` should be `'wrapped'`. |
| F4 | LOW | vendor quirk | `websites` | list shape CHANGES with a filter: bare array when non-empty, `{"websites":[]}` when empty. SDK handles both. |
| F5 | LOW | vendor quirk | `matchers` | `GET /matchers` without `integration_id` → **500** (not 400). SDK types the param required; no-arg JS call 500s. |
| F6 | LOW | vendor bug | `asset_layouts` | `POST /asset_layouts` → **500** for every payload tried (spec has no fields). Create envelope UNVERIFIED. |
| F7 | LOW | vendor bug | `password_folders` | `POST /password_folders` → **500** for every payload tried. Create envelope UNVERIFIED. |
| F8 | LOW | vendor bug | `public_photos` | `POST /public_photos` → **500** (needs a file upload). Create envelope UNVERIFIED. |
| F9 | LOW | SDK gap | `s3_exports` | `POST /s3_exports` returns a **bare record** (with `id`), but `create()` is declared `Promise<void>` and discards it. |
| F10 | INFO | vendor quirk | many | POST status codes are inconsistent: `200` for companies/articles/websites/folders/…, `201` for lists/networks/…. |
| F11 | MED | vendor quirk | pagination | Vendor **ignores `page_size`** (returns all rows on page 1). `listAll` still works here (21<25) but `hasMore` is content-derived and would truncate if a tenant exceeded the vendor cap. UNVERIFIED at scale. |
| F12 | MED | SDK bug (non-envelope) | `redact()` | `redact({apiKey})` returns the key **unmasked** (baseline C33). Not an envelope issue, but a live secret-leak gap. |
| F13 | LOW | harness gap | audit | Baseline C31 expects `durationMs`/`status` on audit events; the real fields are `correlationId, operation, method, path, effect, dryRun, outcome, timestamp, query`. |
| F14 | LOW | SDK/harness gap | dry-run | Baseline C22: a create dry-run claims `reversible:true` but names no compensating path anywhere in the result. |

## Per-resource envelope table

Legend: **bare** = top-level array/object with no envelope key; **{k}** = wrapped in key `k`. "SDK assumes" = `singleKey`/`listKey`/`createType`.

| resource | vendor list (no filter) | vendor list (with filter) | vendor get(id) | vendor POST | vendor PUT | SDK assumes (single/list/create) | SDK return vs declared type | broken? |
|---|---|---|---|---|---|---|---|---|
| activity_logs | bare ARRAY[25] | bare ARRAY[25] | 404 (no get) | n/a | n/a | –/–/raw | `listAll`→array ✓ | no |
| api_info | OBJ{version,date} | n/a | n/a | n/a | n/a | –/–/raw | `get`→ApiInfo ✓ | no |
| **articles** | {articles:4} | {articles:0} | {article} | **200 {article}** | **200 {article}** | article/articles/**raw** | `create`→`{article}` envelope ✗ | **YES (F2)** |
| asset_layouts | {asset_layouts:4} | {asset_layouts:4} | {asset_layout} | **500** | **500** | asset_layout/asset_layouts/wrapped | `create`→500 (UNVERIFIED) | untested (F6) |
| asset_passwords | {asset_passwords:0} | {asset_passwords:0} | (no data) | 200 {asset_password} | 200 {asset_password} | asset_password/asset_passwords/wrapped | `create`→AssetPassword ✓ | no |
| assets | (company-scoped — excluded per coordinator) | | | | | asset/assets/raw | excluded | n/a |
| cards | 404 (no plain list) | n/a | n/a | n/a | n/a | –/integrator_cards/raw | `lookup`→array ✓ | no (vendor has no list) |
| **companies** | {companies:21} | {companies:0} | {company} | **200 {company}** | **200 {company}** | company/companies/**raw** | `create`→`{company}` envelope ✗ | **YES (F1)** |
| expirations | bare ARRAY[3] | bare ARRAY[0] | 404 (no get) | n/a | (update exists) | –/–/raw | `listAll`→array ✓ | no (get/update UNVERIFIED) |
| exports | bare ARRAY[0] | n/a | n/a | 422 (needs params) | n/a | –/–/raw | `create`→void ✓ | untested |
| flag_types | {flag_types:0} | {flag_types:0} | (no data) | 201 {flag_type} | 200 {flag_type} | flag_type/flag_types/wrapped | `create`→FlagType ✓ | no |
| flags | {flags:0} | {flags:0} | (no data) | 422 (needs flag_type+flagable) | n/a | flag/flags/wrapped | `create`→422 (UNVERIFIED) | untested |
| folders | {folders:1} | {folders:0} | {folder} | 200 {folder} | 200 {folder} | folder/folders/wrapped | `create`→Folder ✓ | no |
| groups | {groups:1} | {groups:1} | {group} | 404 (no create) | n/a | group/groups/raw | `listAll`/`get`→Group ✓ | no (vendor has no create) |
| ip_addresses | bare ARRAY[0] | bare ARRAY[0] | (no data) | 201 bare | 400 (no `name` field) | –/–/raw | `create`→IpAddress ✓ | no |
| label_types | {label_types:0} | {label_types:0} | (no data) | 422 (needs valid color+types) | n/a | label_type/label_types/wrapped | `create`→422 (UNVERIFIED) | untested |
| labels | {labels:0} | {labels:0} | (no data) | 422 (needs label_type+labelable) | n/a | label/labels/wrapped | `create`→422 (UNVERIFIED) | untested |
| lists | bare ARRAY[1] | bare ARRAY[1] | bare {id,…} | 201 bare | 200 bare | –/–/raw | `create`→List ✓ | no |
| magic_dash | bare ARRAY[0] | n/a | n/a | 200 bare | 404 (no update) | –/–/raw | `create`→MagicDash ✓ | no (vendor has no update) |
| matchers | **500** (needs integration_id) | **500** | n/a (no get) | n/a | (update exists) | –/matchers/raw | `listAll`→500 w/o integration_id | vendor quirk (F5) |
| networks | bare ARRAY[1] | bare ARRAY[0] | bare {id,…} | 201 bare | 200 bare | –/–/raw | `create`→Network ✓ | no |
| password_folders | {password_folders:0} | {password_folders:0} | (no data) | **500** | **500** | password_folder/password_folders/wrapped | `create`→500 (UNVERIFIED) | untested (F7) |
| photos | {photos:0} | {photos:0} | (no data) | needs file | n/a | photo/photos/wrapped | `create`→needs file (UNVERIFIED) | untested |
| procedure_tasks | {procedure_tasks:0} | {procedure_tasks:0} | (no data) | 201 {procedure_task} | 200 {procedure_task} | procedure_task/procedure_tasks/wrapped | `create`→ProcedureTask ✓ | no |
| **procedures** | {procedures:0} | {procedures:0} | (no data) | **201 {procedure}** | **200 {procedure}** | procedure/procedures/**raw** | `create`→`{procedure}` envelope ✗ | **YES (F3)** |
| public_photos | {public_photos:0} | {public_photos:0} | (no data) | **500** (needs file) | n/a | public_photo/public_photos/raw | `create`→500 (UNVERIFIED) | untested (F8) |
| rack_storage_items | bare ARRAY[0] | 400 (no company_id) | (no data) | (needs nested `rack_storage_item`) | n/a | –/–/raw | UNVERIFIED | untested |
| rack_storages | bare ARRAY[0] | bare ARRAY[0] | (no data) | 201 bare | 200 bare | –/–/raw | `create`→RackStorage ✓ | no |
| relations | {relations:0} | {relations:0} | (no data) | 422 (needs fromable+toable) | n/a | relation/relations/wrapped | `create`→422 (UNVERIFIED) | untested |
| s3_exports | 404 (no list) | n/a | n/a | 200 **bare** (has id) | n/a | –/–/raw | `create`→void (discards id) | minor (F9) |
| uploads | bare ARRAY[0] | bare ARRAY[0] | (no data) | needs file | n/a | –/–/raw | UNVERIFIED | untested |
| users | {users:1} | {users:1} | {user} | n/a (no create) | n/a | user/users/raw | `listAll`/`get`→User ✓ | no (vendor has no create) |
| vlan_zones | bare ARRAY[0] | bare ARRAY[0] | (no data) | 201 bare | 200 bare | –/–/raw | `create`→VlanZone ✓ | no |
| vlans | bare ARRAY[0] | bare ARRAY[0] | (no data) | 201 bare | 200 bare | –/–/raw | `create`→Vlan ✓ | no |
| websites | bare ARRAY[2] | bare ARRAY[2] / **{websites:0}** when empty | bare {id,…} | 200 bare | 422 (name must be URL) | website/websites/raw | `create`→Website ✓ | no (list shape-changes, F4) |

## Declared-type vs runtime mismatches (ranked by blast radius)

| rank | resource | declared type | runtime value | blast radius | minimal live repro |
|---|---|---|---|---|---|
| 1 | `companies` | `Promise<Company>` | `{ company: Company }` | **Highest** — `companies` is the root resource; MCP tool `companies.create`; `resolve`/`getContext`/company-scoped helpers all key off it. | `const c = await hudu.companies.create({ name: 'ZZ' }); console.log(typeof c.id)` → `undefined` (id is at `c.company.id`). |
| 2 | `articles` | `Promise<Article>` | `{ article: Article }` | High — articles are core content; MCP tool `articles.create`; `articles.resolve`/`findBySlug`. | `const a = await hudu.articles.create({ name: 'ZZ', company_id: 3, content: 'x' }); console.log(typeof a.id)` → `undefined`. |
| 3 | `procedures` | `Promise<Procedure>` | `{ procedure: Procedure }` | Medium — procedures feed `procedure_tasks`; MCP tool `procedures.create`. | `const p = await hudu.procedures.create({ name: 'ZZ', company_id: 3 }); console.log(typeof p.id)` → `undefined`. |

**Root cause (all three):** `BaseResource.createOne` returns `this.createType === 'wrapped' ? unwrapSingle(body) : body`. These three declare `createType: 'raw'`, so the wrapped POST body is returned verbatim. `updateOne` always unwraps by `singleKey`, which is why `update()` is correct and only `create()` is broken. **Fix:** set `createType: 'wrapped'` for `companies`, `articles`, `procedures` (the vendor wraps both POST and PUT for all three — verified live).

**Spec vs live:** the vendored `api-docs.json` says `POST /companies` → `201 $ref Company` (bare). The live vendor returns `200 {"company":{…}}`. So the spec and the live vendor **disagree** on the create envelope; the SDK was built to the spec (`raw`) and the live vendor wraps. (Per coordinator: note per-resource whether live follows spec or wraps — for these three, live WRAPS despite the spec saying bare.)

## Resources NOT exercised (no data / unsafe / company-scoped / vendor 500)

| resource | reason |
|---|---|
| `assets` | company-scoped; excluded per coordinator (separate 500 being fixed). |
| `asset_layouts` (create) | vendor **500** on every payload; spec has no fields. List/get verified; create envelope UNVERIFIED. |
| `password_folders` (create) | vendor **500** on every payload. List verified; create envelope UNVERIFIED. |
| `public_photos` (create) | vendor **500** (needs a file upload). List verified; create envelope UNVERIFIED. |
| `photos` (create) | needs a file upload (multipart). List verified; create envelope UNVERIFIED. |
| `uploads` (create) | needs a file upload. List verified; create envelope UNVERIFIED. |
| `flags` (create) | needs an existing `flag_type_id` + `flagable` (422 without). List verified; create envelope UNVERIFIED. |
| `labels` (create) | needs an existing `label_type_id` + `labelable` (422 without). List verified; create envelope UNVERIFIED. |
| `label_types` (create) | needs valid `color` + `applicable_record_types` enums (422 without). List verified; create envelope UNVERIFIED. |
| `relations` (create) | needs `fromable` + `toable` records (422 without). List verified; create envelope UNVERIFIED. |
| `rack_storage_items` (create) | needs a nested `rack_storage_item` body + parent; 400 on `company_id` filter. List verified; create envelope UNVERIFIED. |
| `matchers` (list) | `GET /matchers` requires `integration_id`; no integrations in this tenant → 500. UNVERIFIED. |
| `expirations` (get/update) | no `GET /expirations/{id}` (404); create needs an `expirationable`. List verified (bare array); get/update UNVERIFIED. |
| `exports` (create) | 422 "export parameter missing" — needs specific export params. List verified (bare array); create envelope UNVERIFIED. |
| `users` / `groups` (create) | vendor exposes **no** POST (404 / spec has only GET). SDK correctly omits `create`. List/get verified. |
| `cards` (list) | vendor has no plain `GET /cards` (404); only `/cards/lookup` + `/cards/jump`. SDK correctly exposes only those. |
| `s3_exports` (list) | vendor has no `GET /s3_exports` (404). SDK correctly exposes only `create`. |

## Baseline harness (40 checks) — 34 PASS / 6 FAIL / 0 SKIP

| id | name | status | detail / classification |
|---|---|---|---|
| C07 | pagination reaches beyond page 1 | **FAIL** | vendor ignores `page_size` (page 1 returned all 21). → F11 (vendor quirk; truncation risk at scale UNVERIFIED). |
| C22 | create dry-run names a compensating path | **FAIL** | dry-run claims `reversible:true` but names no undo/delete. → F14 (SDK/harness gap). |
| C31 | onAudit fires with durationMs/status | **FAIL** | audit events have no `durationMs`/`status`. → F13 (harness gap — real fields differ). |
| C33 | redact() masks credentials | **FAIL** | `redact({apiKey})` returns the key unmasked. → F12 (SDK bug, non-envelope). |
| C38 | registry pagination mode matches live | **FAIL** | `matchers.listAll()` with no `integration_id` → 500. → F5 (vendor quirk + harness calls no-arg). |
| C39 | create() honours declared return type | **FAIL** | `companies.create` returned `{company}` envelope. → **F1 (SDK bug, this lens)**. |
| (other 34) | — | PASS | includes C25/C26/C27 create:update:delete round-trip, C11/C12 page-param handling, C14 NOT_FOUND, C37 registry↔method map, C40 MCP manifest. |

## Method & safety notes

- Raw bodies captured with `fetch` + `X-API-Key`; the key is never written to this file or any repo file.
- **Every record I created was deleted before finishing.** Final sweep across all 31 listable resources: **0 strays**.
  Pre-existing data intact: **21 companies, 2 websites (google.com, democorp.com.au), 1 group (Default Group)**, 4 articles,
  4 asset_layouts, 3 expirations, 1 folder, 1 list, 1 network, 1 user.
- `activity_logs.deleteAll` / `magic_dash.delete` were **not** run for real (dry-run only, per rules).
- **One caveat:** to capture the `s3_exports` create envelope I issued one `POST /s3_exports` (returned a bare record, id 1).
  The vendor exposes **no** `DELETE /s3_exports/{id}` (404) and no `GET /s3_exports` (404), so that transient export job
  cannot be removed via the API. It is an ephemeral export job, not persistent tenant data, but it is the one record I
  could not clean up.
- `assets` (company-scoped) excluded per coordinator.
- Repro scripts (raw fetch + SDK) are in `/tmp/probe{1,2,3a,3b,3c,4}.mjs`, `/tmp/verify.mjs`, `/tmp/cleanup.mjs` (not in the repo).

---

## Coordinator verification (added after the report was filed)

| Finding | Verdict | Evidence / action |
|---|---|---|
| F1 companies.create envelope | **CONFIRMED → FIXED** | `companies.create()` now returns a `Company` with a real id (live id 66, then deleted). Fixed in `f4c48c6` at the `BaseResource` choke point rather than by flipping `createType`, so the same class is closed for every resource, not just the three observed. |
| F2 articles.create envelope | **CONFIRMED → FIXED** | live `articles.create({name, content, company_id: 13})` returns the Article (id 22, then deleted) |
| F3 procedures.create envelope | **CONFIRMED (by the sweep) → FIXED** | covered by the same generic fix; not re-exercised live by the coordinator |
| F11 "vendor ignores page_size" | **FALSIFIED** | direct probe: `/companies?page=1&page_size=5` returns **5** rows, `/companies?page=1&page_size=100` returns 21, `/activity_logs?page=1&page_size=5` returns **5**, `/activity_logs?page=1&page_size=100` returns **100**. `page_size` IS honoured; the SDK's content-derived `hasMore` is sound. No fix needed. (The claim likely came from a resource whose total row count was below the requested page size, which looks like "all rows on page 1".) |
| F12 redact() apiKey | **CONFIRMED → FIXED** | `ad7be82`; credential keys are now compared with separators removed, so `apiKey`/`apikey`/`api_key`/`api-key` all mask, and `accessToken`/`clientSecret`/`otpSecret` are covered by the suffix rules. |
| F5 matchers 500 | **CONFIRMED → FIXED** | `da9d273`; the list primitives refuse a missing/invalid `integration_id` before any IO (0 requests), the helper tier already did. |
| F13/F14 harness gaps | **CONFIRMED → harness corrected** | the audit check now asserts the real field set (no `durationMs`/`status`), and the reversibility check compares against whether the resource actually has a delete/archive primitive. |
| F9 s3_exports discards the returned id | **ACCEPTED (documented)** | `create()` is declared `Promise<void>`; widening it to return the record would change a published signature, which the additive-only rule forbids. Kept as a documented LOW. |
| F6/F7/F8 vendor 500 on POST | **ACCEPTED (vendor bugs)** | the SDK correctly surfaces `ServerError`; nothing to fix client-side. |

Verdict on the lens: the sweep found the create-path half of the envelope bug class that the coordinator's
first pass had only closed for lists and gets, and its one wrong claim was caught and falsified with evidence.
