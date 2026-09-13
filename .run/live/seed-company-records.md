# Live test-coverage seeding — assets, asset_passwords, cards, password_folders, folders, flags, flag_types, lists, users, groups

Tenant: `https://hudu-sandbox.example.com` (sandbox). Credentials passed via `HUDU_BASE_URL` / `HUDU_API_KEY` env only; the key appears in no file and in no command string in this report.
Branch `feat/agent-execution-layer`, never switched, nothing committed, no source file edited (so no rebuild was needed).
Drivers live in `/tmp` (`/tmp/seed1..7.mjs`, `/tmp/probe.mjs`); raw evidence JSON: `/tmp/seed-log*.json`, `/tmp/sweep-{before,seeded,after}.json`.

## Method
- Baseline sweep: `node scripts/live-coverage.mjs --json /tmp/sweep-before.json` (all 225 registry ops).
- Seeded sweep (my records present): `node scripts/live-coverage.mjs --json /tmp/sweep-seeded.json`.
- Clean sweep (after full cleanup): `node scripts/live-coverage.mjs --json /tmp/sweep-after.json`.
- Reads called for real; every write called with `{ dryRun: true }` as the LAST argument first, then really, then deleted.
- Guards: `update` with `expectedUpdatedAt: '2000-01-01T00:00:00.000Z'` (stale) then with the freshly read `updated_at` (fresh), reading the record back after each attempt.
- Seed order: flag_type -> flag, password_folder -> asset_password, folder, list, asset (company 13, layout 1).

## Coverage before -> after (my resources only)

`before` = tenant nearly empty; `seeded` = with my created records live; `after` = clean again.

| Sweep | DRY_OK | LIVE_OK | SKIP | LIVE_REFUSED | THREW |
|-------|--------|---------|------|--------------|-------|
| before | 51 | 61 | 97 | 15 | 1 |
| seeded | 70 | 85 | 49 | 20 | 1 |
| after  | 60 | 76 | 71 | 17 | 1 |

Moved out of SKIP while my records existed (22 ops, all of them mine):

`asset_passwords.{archive,delete,get,unarchive,update,resolve,search,findBySlug}`, `flag_types.{delete,get,update,resolve}`,
`flags.{delete,get,update,resolve,findByFlagable}`, `password_folders.{delete,get,update,resolve,search}`.

The sweep is always re-run against an empty tenant at the end, so the `after` column reverts to SKIP: a read/helper needs a live row, and I deleted everything I created (cleanup proof below). The honest "after" number is therefore the `seeded` column, not the `after` column.

Still SKIP in the `seeded` sweep, and why that is a sweep limitation rather than a gap in my exercise:
- `assets.{resolve,search,findBySerial,getContext}` — "no live row of this resource to resolve": the sweep derives its id from a un-scoped `assets.list()`, which requires a companyId.
- `assets.listAcrossCompanies` — "unclassified method shape" (it is an AsyncIterable; the sweep does not classify it).
- `cards.{lookup,jump}` — "unclassified method shape"; `cards.resolve` — no live row (see cards below).

## Per-operation status

| Resource | Operation | Status | Evidence (exact command) |
|----------|-----------|--------|--------------------------|
| assets | get | LIVE_OK | `await hudu.assets.get(13,356)` -> flat Asset (id, company_id, asset_layout_id, slug, name, primary_serial, archived, fields[], cards[]) |
| assets | get (missing id) | LIVE_OK (NOT_FOUND) | `await hudu.assets.get(13,999999)` -> NOT_FOUND "Asset not found" |
| assets | get (id under another company) | LIVE_OK (NOT_FOUND) | `await hudu.assets.get(3,356)` -> NOT_FOUND "Asset not found" |
| assets | list | LIVE_OK | `for await (const x of hudu.assets.list(13))` -> 5 ids |
| assets | list (no companyId) | LIVE_OK (CONFIG_ERROR by design) | `await hudu.assets.listAll()` -> CONFIG_ERROR `assets.listAll requires a positive integer companyId, got "undefined"` |
| assets | listAll | LIVE_OK | `await hudu.assets.listAll(13)` -> 5 rows |
| assets | listPages | LIVE_OK | `for await (const p of hudu.assets.listPages(13))` -> 1 page |
| assets | create (dry-run) | DRY_OK | `await hudu.assets.create(13,{name:'zz-live-seed-asset',asset_layout_id:1,primary_serial:'ZZLIVESEED01',custom_fields:[{category:'Other'},{version:'1.0'}]},{dryRun:true})` -> wouldApply true, checks `payload-present`, impact affected 1 / single / reversible, warning `server-computed fields are not guaranteed by dry-run` |
| assets | create (real) | LIVE_OK, see DEFECT-2 | `await hudu.assets.create(13,{...same...})` -> created id 356 (read from the returned envelope) |
| assets | update (dry-run) | DRY_OK | `await hudu.assets.update(13,356,{name:'zz-live-seed-asset-u'},{dryRun:true})` -> wouldApply true, checks `target-identifier` + `payload-present` |
| assets | update (real) | LIVE_OK | `await hudu.assets.update(13,356,{name:'zz-live-seed-asset-u'})` -> returned `{ asset: {...} }` |
| assets | update (stale guard) | **DEFECT-1: guard silently ignored, write LANDED** | `await hudu.assets.update(13,356,{name:'STALE-LANDED'},{expectedUpdatedAt:'2000-01-01T00:00:00.000Z'})` -> no error; read-back `hudu.assets.get(13,356)` shows `name "STALE-LANDED"`, `updated_at` advanced 02:54:47.411Z -> 02:55:06.467Z |
| assets | update (fresh guard) | LIVE_OK | same call with `expectedUpdatedAt` = the freshly read `updated_at` -> applied, name changed |
| assets | delete (dry-run) | DRY_OK | `await hudu.assets.delete(13,357,{dryRun:true})` -> wouldApply true, reversible true |
| assets | delete (real) | LIVE_OK | `await hudu.assets.delete(13,357)` then `hudu.assets.delete(13,356)`, `(13,354)`, `(13,352)`, `(13,353)` -> `hudu.assets.get(13,352)` -> NOT_FOUND |
| assets | archive (dry-run + real) | LIVE_OK | `await hudu.assets.archive(13,356,{dryRun:true})` then `await hudu.assets.archive(13,356)` -> read-back `archived: true` |
| assets | unarchive (dry-run + real) | LIVE_OK | `await hudu.assets.unarchive(13,356,{dryRun:true})` then `await hudu.assets.unarchive(13,356)` -> read-back `archived: false` |
| assets | moveLayout (dry-run + real) | LIVE_OK | `await hudu.assets.moveLayout(13,356,{asset_layout_id:2},{dryRun:true})` then `...({asset_layout_id:2})` -> read-back `asset_layout_id: 2`; moved back to 1 |
| assets | listAcrossCompanies | LIVE_OK | `for await (const x of hudu.assets.listAcrossCompanies())` -> 25 ids (21 non-seed) |
| assets | listAllAcrossCompanies | LIVE_OK | `await hudu.assets.listAllAcrossCompanies()` -> 25 rows |
| assets | listAcrossCompaniesPages | LIVE_OK | `for await (const p of hudu.assets.listAcrossCompaniesPages())` -> 1 page, 25 rows |
| assets | resolve (id) | LIVE_OK | `await hudu.assets.resolve(356)` -> AssetSummary |
| assets | resolve ({id}, {companyId}) | LIVE_OK | `await hudu.assets.resolve({id:356},{companyId:13})` -> AssetSummary |
| assets | resolve (serial / name) | LIVE_OK | `await hudu.assets.resolve('ZZLIVESEED02')`, `await hudu.assets.resolve('zz-live-seed-uniq')` -> AssetSummary |
| assets | resolve (ambiguous) | LIVE_OK (RESOLUTION_AMBIGUOUS) | 4 seed assets shared serial `ZZLIVESEED01`; `await hudu.assets.resolve('ZZLIVESEED01')` -> RESOLUTION_AMBIGUOUS "4 assets match the identifier exactly" |
| assets | resolve ({resolutionDetails}) | LIVE_OK | `await hudu.assets.resolve(356,{resolutionDetails:true})` -> `{value, resolutionCost, scanned, scanTruncated}` |
| assets | findBySerial | LIVE_OK | `await hudu.assets.findBySerial('ZZLIVESEED02')` -> AssetSummary; with the duplicated serial it threw RESOLUTION_AMBIGUOUS |
| assets | search | LIVE_OK | `await hudu.assets.search('zz-live-seed')` -> 4 rows; `await hudu.assets.search('zz-live-seed',{companyId:13})` -> 4 rows |
| assets | getContext | LIVE_OK | `await hudu.assets.getContext(356)` and `await hudu.assets.getContext({id:356})` and `await hudu.assets.getContext('ZZLIVESEED02')` -> `{asset, layout, expirations, relations}` |
| asset_passwords | list | LIVE_OK | `await hudu.assetPasswords.listAll()` -> 0 rows before seeding, 1 after (`await hudu.assetPasswords.listAll()`) |
| asset_passwords | listPages | LIVE_OK | `for await (const p of hudu.assetPasswords.listPages())` -> 1 page |
| asset_passwords | get | LIVE_OK (SENSITIVE) | `await hudu.assetPasswords.get(3)` -> full record INCLUDING plaintext `password` |
| asset_passwords | create (dry-run) | DRY_OK, no secret echoed | `await hudu.assetPasswords.create({name:'zz-probe',password:'<secret>',username:'zzseed',company_id:13},{dryRun:true})` -> `{operation, wouldApply, target, request, checks:[payload-present], impact, simulated, warnings}`; the dry-run body contains NO copy of the password |
| asset_passwords | create (real) | LIVE_OK | `await hudu.assetPasswords.create({name:'zz-live-seed-password',username:'zzseed',password:'<secret>',company_id:13,password_folder_id:1})` -> id 3, returns plaintext `password` |
| asset_passwords | update (dry-run + real, stale + fresh) | LIVE_OK, guard WORKS | stale: `await hudu.assetPasswords.update(3,{description:'stale'},{expectedUpdatedAt:'2000-01-01T00:00:00.000Z'})` -> STALE_OBJECT, read-back unchanged (`description` and `updated_at` identical). fresh: same call with the read `updated_at` -> applied |
| asset_passwords | archive / unarchive | LIVE_OK | `{dryRun:true}` first, then real; read-back `archived: true`, then `false` |
| asset_passwords | delete (dry-run + real) | LIVE_OK | `await hudu.assetPasswords.delete(4,{dryRun:true})`, real delete, then `await hudu.assetPasswords.get(4)` -> NOT_FOUND "the vendor answered 200 with an empty body" |
| asset_passwords | resolve (id / name / {name} / expand / resolutionDetails) | LIVE_OK (secret-safe) | `await hudu.assetPasswords.resolve(3)`, `(3,{expand:true})`, `(3,{resolutionDetails:true})` -> summaries carry NO `password`/`otp_secret`; `expand:true` returns the full record with the secret |
| asset_passwords | findBySlug | LIVE_OK (secret-safe) | `await hudu.assetPasswords.findBySlug('b181d8b25e09')` -> summary without the secret |
| asset_passwords | search | LIVE_OK (secret-safe by default) | `await hudu.assetPasswords.search('zz-live-seed')` -> 1 summary without the secret; `search(...,{expand:true})` -> full records WITH the secret (documented) |
| cards | lookup | LIVE_OK (NOT_FOUND) | `await hudu.cards.lookup({integration_slug:'zz-no-such-integration'})` -> NOT_FOUND "No matching integration" (the tenant has no company_integration to key a real card) |
| cards | jump | LIVE_OK (partial) | `await hudu.cards.jump({integration_type:'zz',integration_slug:'zz-no-such-integration'})` -> returned `https://hudu-sandbox.example.com/dashboard`; a REAL jump target is UNVERIFIED |
| cards | resolve | LIVE_OK (NOT_FOUND) | `await hudu.cards.resolve({integration_slug:'zz-no-such-integration'})` -> NOT_FOUND "No matching integration" |
| cards | create/update/delete/list | N/A | the resource exposes only `lookup`, `jump`, `resolve` (`Object.getOwnPropertyNames(Object.getPrototypeOf(hudu.cards))` = constructor,lookup,jump,resolve); the registry has exactly those three ops |
| password_folders | list / listPages | LIVE_OK | `await hudu.passwordFolders.listAll()` -> 0 before, 1 after; `listPages()` -> 1 page |
| password_folders | get | LIVE_OK | `await hudu.passwordFolders.get(1)` -> id, name, company_id, slug, security |
| password_folders | create (dry-run + real) | DRY_OK + LIVE_OK | `await hudu.passwordFolders.create({name:'zz-live-seed-pwfolder',security:'all_users',company_id:13},{dryRun:true})` then real -> id 1 |
| password_folders | update (dry-run + real, stale + fresh) | LIVE_OK, guard WORKS | stale -> STALE_OBJECT and read-back unchanged; fresh -> applied |
| password_folders | resolve (id / name) | LIVE_OK | `await hudu.passwordFolders.resolve(1)`, `await hudu.passwordFolders.resolve('zz-live-seed-pwfolder')` -> summary |
| password_folders | search | LIVE_OK | `await hudu.passwordFolders.search('zz-live-seed')` -> 1 row |
| password_folders | delete (dry-run + real) | LIVE_OK | `{dryRun:true}` then real -> final `listAll()` = 0 |
| folders | list / listPages / get | LIVE_OK | `hudu.folders.listAll()` -> 1 (pre-existing) then 2; `hudu.folders.get(5)`; `listPages()` -> 1 page |
| folders | create (dry-run + real) | DRY_OK + LIVE_OK | `await hudu.folders.create({name:'zz-live-seed-folder',description:'live seed',company_id:13,folder_type:'article'},{dryRun:true})` then real -> id 5 |
| folders | update (dry-run + real, stale + fresh) | LIVE_OK, guard WORKS | stale -> STALE_OBJECT, read-back `description`/`updated_at` unchanged; fresh -> applied |
| folders | resolve (id / name / {name,companyId}) | LIVE_OK | `await hudu.folders.resolve(5)`, `('zz-live-seed-folder')`, `({name:'zz-live-seed-folder',company_id:13})` |
| folders | delete (dry-run + real) | LIVE_OK | `{dryRun:true}` then real -> back to 1 row |
| folders | search | N/A | `folders` exposes no `search` helper (registry: get/list/create/update/delete/resolve only) |
| flags | list / listPages / get | LIVE_OK | `hudu.flags.listAll()` -> 0 before, 1 after; `hudu.flags.get(1)`; `listPages()` -> 1 page |
| flags | create (dry-run + real) | DRY_OK + LIVE_OK | `await hudu.flags.create({flag_type_id:3,flagable_type:'Company',flagable_id:13,description:'zz-live-seed-flag'},{dryRun:true})` then real -> id 1 |
| flags | update (dry-run + real, stale + fresh) | LIVE_OK, guard WORKS | stale -> STALE_OBJECT + read-back unchanged; fresh -> applied |
| flags | resolve | LIVE_OK | `await hudu.flags.resolve(1)` -> `{id, flag_type_id, description, flagable_type, flagable_id, updated_at}` |
| flags | findByFlagable | LIVE_OK | `await hudu.flags.findByFlagable('Company',13)` -> 1 flag |
| flags | delete (dry-run + real) | LIVE_OK | `{dryRun:true}` then real; `await hudu.flags.get(1)` -> NOT_FOUND "Flag not found" |
| flag_types | list / listPages / get | LIVE_OK | `hudu.flagTypes.listAll()` -> 0 before, 1 after; `hudu.flagTypes.get(3)`; `listPages()` |
| flag_types | create (dry-run + real) | DRY_OK + LIVE_OK | `await hudu.flagTypes.create({name:'zz-live-seed-flagtype',color:'Blue'},{dryRun:true})` then real -> id 3 |
| flag_types | update (dry-run + real, stale + fresh) | LIVE_OK, guard WORKS | stale -> STALE_OBJECT "flag_types 3 was not at the expected revision"; fresh -> applied |
| flag_types | resolve (id / name / slug / expand / resolutionDetails / miss) | LIVE_OK | `resolve(3)`, `resolve('zz-live-seed-flagtype')`, `resolve(slug)`, `resolve(3,{expand:true})`, `resolve(3,{resolutionDetails:true})`, miss -> `null` |
| flag_types | delete (dry-run + real) | LIVE_OK | `{dryRun:true}` then real -> 0 rows |
| lists | list / listPages / get | LIVE_OK | `hudu.lists.listAll()` -> 1 (pre-existing) then 2; `hudu.lists.get(4)`; `listPages()` |
| lists | create (dry-run + real) | DRY_OK + LIVE_OK | `await hudu.lists.create({name:'zz-live-seed-list',list_items_attributes:[{name:'item-a'},{name:'item-b'}]},{dryRun:true})` then real -> id 4 |
| lists | update (dry-run + real, stale + fresh) | LIVE_OK, guard WORKS | stale -> STALE_OBJECT + read-back unchanged; fresh -> applied |
| lists | resolve (id / name) + findByName | LIVE_OK | `resolve(4)`, `resolve('zz-live-seed-list')`, `findByName('zz-live-seed-list')` |
| lists | delete (dry-run + real) | LIVE_OK | `{dryRun:true}` then real -> back to 1 row |
| users | list / listPages / get | LIVE_OK | `hudu.users.listAll()` -> 1; `hudu.users.get(1)`; `listPages()` -> 1 page |
| users | resolve (id / email / {resolutionDetails}) | LIVE_OK | `resolve(1)`, `resolve('user@example.com')`, `resolve(1,{resolutionDetails:true})` |
| users | resolve (slug) | **DEFECT-3a: null** | `await hudu.users.resolve('0000000000')` -> `null`, while `await hudu.users.listAll({slug:'0000000000'})` -> 1 row |
| users | resolve (name) | **DEFECT-3b: null** | `await hudu.users.resolve('Max Soukhomlinov')` -> `null`; `await hudu.users.listAll({search:'Soukhomlinov'})` -> 1 row |
| users | findByEmail | LIVE_OK | `await hudu.users.findByEmail('user@example.com')` -> summary; miss -> `null` |
| users | search | LIVE_OK (email gap) | `await hudu.users.search('Max')` -> 1 row; `await hudu.users.search('user@example.com')` -> 0 rows (see OBS-1) |
| users | create / update / delete | N/A | the resource exposes constructor,get,list,listAll,listPages,resolve,findByEmail,search,scanBy,scanUnique only; nothing to seed |
| groups | list / listPages / get | LIVE_OK | `hudu.groups.listAll()` -> 1; `hudu.groups.get(1)`; `listPages()` -> 1 page |
| groups | resolve (id / name / {id} / {resolutionDetails}) | LIVE_OK | `resolve(1)`, `resolve('Default Group')`, `resolve({id:1})`, `resolve(1,{resolutionDetails:true})` |
| groups | resolve (slug / {slug}) | **DEFECT-3a (same class): null** | `await hudu.groups.resolve('9fd63e9f4ca2')` -> `null` and `resolve({slug:'9fd63e9f4ca2'})` -> `null`, while `await hudu.groups.listAll({slug:'9fd63e9f4ca2'})` -> 1 row |
| groups | search | LIVE_OK | `await hudu.groups.search('Def')` -> 1 row; `await hudu.groups.search('Default Group')` -> 1 row; `search(<slug>)` -> 0 rows |
| groups | create / update / delete | N/A | the resource exposes constructor,get,list,listAll,listPages,resolve,search,scanExact,decideScan,resolveRecord only |

## Defects found (with repro)

### DEFECT-1 (HIGH) — `assets.update` silently ignores `expectedUpdatedAt`; the stale write LANDS
`hudu.assets.update(companyId, id, data, { expectedUpdatedAt })` performs the PUT instead of raising STALE_OBJECT.
Repro (id 356, company 13):
1. `const before = await hudu.assets.get(13, 356)` -> `updated_at "2026-09-13T02:54:47.411Z"`, name `zz-live-seed-asset-u`.
2. `await hudu.assets.update(13, 356, { name: 'STALE-LANDED' }, { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' })` -> **resolves**, returns `{ asset: {...} }`, no error.
3. `await hudu.assets.get(13, 356)` -> name `STALE-LANDED`, `updated_at "2026-09-13T02:55:06.467Z"` (write landed).
Contrast: `flag_types`, `flags`, `password_folders`, `asset_passwords`, `folders` and `lists` all threw `STALE_OBJECT` on the same repro and left the record unchanged.
Cause: `src/resources/assets.ts` `update()` hand-rolls the PUT and never routes through `updateOne`, so `BaseResource.assertNotStale` never runs. The doc comment says `staleCheck` is "unavailable" for assets — but the option is still accepted by `AssetWriteOptions` and then dropped with no error and no warning, which is worse than refusing it (`assertExpectedAtNotOnNonUpdate` in `base.ts` refuses this shape elsewhere). An agent that passes the guard gets a lost-update instead of a refusal.

### DEFECT-2 (MEDIUM) — `assets.create` / `update` / `moveLayout` return the vendor envelope, unwrapped
Repro: `const r = await hudu.assets.create(13, {...})` -> `Object.keys(r)` is `["asset"]`; `r.id === undefined`, the id sits at `r.asset.id`.
`assets.update(...)` and `assets.moveLayout(...)` return the same `{ asset: {...} }` shape. `assets.get(...)` by contrast returns a flat Asset.
The inline comment ("The 201 response is a flat Asset, so no unwrap is applied", `src/resources/assets.ts`) contradicts the live API.
Impact: the natural chaining idiom `const a = await hudu.assets.create(13, d); await hudu.assets.get(13, a.id)` reads id `undefined`; my first cleanup attempt used that id and got NOT_FOUND while the asset stayed live. Three probe assets (352, 353, 354) leaked this way and had to be found by listing and deleted by hand.

### DEFECT-3 (MEDIUM) — `resolve` slug (groups, users) and name (users) stages use a `search` filter the vendor does not match
- `await hudu.groups.resolve('9fd63e9f4ca2')` -> `null`; `await hudu.groups.resolve({slug:'9fd63e9f4ca2'})` -> `null`; but `await hudu.groups.listAll({slug:'9fd63e9f4ca2'})` -> **1 row**. The vendor DOES support a slug filter; `groups.resolve` narrows with `{ search: slug }` instead (`src/resources/groups.ts` `resolveRecord`, `kind === 'slug'`), and `groups.search(<slug>)` -> 0 rows, so the scan always misses.
- `await hudu.users.resolve('0000000000')` -> `null` while `await hudu.users.listAll({slug:'0000000000'})` -> 1 row: same cause.
- `await hudu.users.resolve('Max Soukhomlinov')` -> `null` while `await hudu.users.listAll({search:'Soukhomlinov'})` -> 1 row: the name stage passes the two-word full name to `search`, which matches neither the full string (`users.listAll({search:'Max Soukhomlinov'})` -> 0) nor the row; the exact compare is against `fullName(user)` = `"Max Soukhomlinov"`, so a single word can never match either.
Impact: a documented identifier kind (`slug`, and `name` for users) can never resolve on this tenant. Fix: use the vendor's `slug` filter (`groups.listAll({slug})` / `users.listAll({slug})`), and for users compare `fullName` against the scanned rows instead of relying on the vendor search.

### DEFECT-4 (LOW) — `assets.create` rejects the documented `custom_fields` shape, and `dryRun` does not catch it
- `api-docs.json` prose (POST `/companies/{company_id}/assets`) says `custom_fields` is a key/value map; the same file's schema says `type: "array"`; the live API requires the **array of single-key objects** form.
- `{ custom_fields: { category: 'Other', version: '1.0' } }` -> `UNPROCESSABLE_ENTITY "Invalid custom fields"` (also with `Category`, and with the category key alone). `[{ category: 'Other' }, { version: '1.0' }]` -> 201.
- The failed object form was reported `wouldApply: true` by `{ dryRun: true }` (checks are only `payload-present`), so a dry-run OK does not predict a vendor 422 for this resource.
- Also note the dropdown value must be one of the layout's options ("Seed" -> 422; the layout's `fields[0].options` are CRM/Database/ERP/Finance/Marketing/Sales/Other).

### OBS-1 (LOW/UNVERIFIED) — `users.search` does not match an email address
`await hudu.users.search('user@example.com')` -> 0 rows for the only user whose `email` is exactly that (`users.listAll({email})` -> 1 row). `search('Max')` -> 1 row, so search works on name only. I did not test whether the vendor intends email search to work — UNVERIFIED whether this is an SDK or a vendor limitation.

### OBS-2 (INFO) — `cards` cannot be positively exercised on this tenant
`cards.lookup` / `cards.resolve` need a `company_integration` slug/id; this tenant has none, so both returned `NOT_FOUND "No matching integration"`. `cards.jump` returned the dashboard URL for a fake slug, so a real jump target is UNVERIFIED. No card was created (the resource is read-only: `lookup`, `jump`, `resolve` only).

### OBS-3 (INFO) — `asset_passwords` returns plaintext secrets on the raw primitives
`assetPasswords.create`, `.get`, `.list`/`.listAll` all return `password` (and `otp_secret`) in cleartext — verified: `get(3).password` equalled the value I created. That is correct per the resource contract ("get returns the full record, including the secret"; registry `flags: ["sensitive"]`), and the helper tier is secret-safe as designed: `resolve`, `search`, `findBySlug` summaries carry no `password`/`otp_secret` key at all, while `{ expand: true }` returns the full record on purpose. `assetPasswords.create(..., { dryRun: true })` does NOT echo the secret in its `request` block (verified on the raw result). No defect — recorded because the task asked for the sensitive flag to be exercised.

## UNVERIFIED
- `cards`: a positive `lookup` / `resolve` match and a real `jump` target — the tenant has no integrator integration to key a card (OBS-2).
- `users.search` by email (OBS-1).
- `assets.resolve` / `assets.findBySerial` / `assets.getContext` by a serial that is unique **in the whole account** were verified with a single-match record; the ambiguous path was verified with 4 matches. A cross-company duplicate serial in a different company was not re-tested after the ambiguity case.
- The `assets.update` fresh-guard and the stale-guard of the six other resources were each run once; no concurrency (two writers racing) was tested.

## Cleanup proof

Every record I created was deleted **through the API** (children before parents): `flags.delete` -> `flagTypes.delete`; `assetPasswords.delete` -> `passwordFolders.delete`; `assets.delete` (5 assets); `folders.delete`; `lists.delete`. All returned OK; two rounds of seeding were cleaned (round 1 ids 3/1/1/3/5/4 + assets 356/354/352/353, round 2 ids 4/2/6/5/2/4 + asset 358).

Final state (`node /tmp/seed7.mjs`):

| Resource | Final count | Baseline |
|----------|-------------|----------|
| assets (company 13) | 1 | 0 pre-existing (verified: a listing taken while only my seeds existed returned exactly ids 352,353,354). The 1 remaining asset is NOT mine: `ZZ Seed Expiring Asset`, id 355, serial `ZZSEED1`, created 02:54:38Z by a parallel worker. |
| assetsAcrossCompanies | 21 | 21 (measured with my 4 seeds present: 25 rows - 4 mine) |
| assetPasswords | 0 | 0 |
| folders | 1 | 1 |
| flags | 0 | 0 |
| flagTypes | 0 | 0 |
| lists | 1 | 1 |
| passwordFolders | 0 | 0 |
| users | 1 | 1 |
| groups | 1 | 1 |
| companies | 21 | 21 |
| articles | 4 | 4 |
| assetLayouts | 4 | 4 |
| activityLogs | 466 | 466 |

Leftover scan for anything of mine: `zz-`-prefixed rows across assets, folders, lists, passwordFolders, assetPasswords, flags, flagTypes -> **all empty** (`{"assets":[],"folders":[],"lists":[],"passwordFolders":[],"assetPasswords":[],"flags":[],"flagTypes":[]}`).
The tenant is unchanged. No record is known to be undeletable.
