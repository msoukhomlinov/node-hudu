# Live seed workflow: procedures, procedure_tasks, expirations, magic_dash, photos, public_photos, uploads, labels, label_types, matchers, exports

Repo: /Users/maxs/gitrepos/node-hudu, branch `feat/agent-execution-layer` (never switched, nothing committed or pushed).
Tenant: hudu-sandbox.example.com (throwaway key from the brief; the key is never written into the repo or this file).
Evidence files (outside the repo): `/tmp/seedwf-ev.json` (111 recorded steps), `/tmp/seed-ev-a.json`, `/tmp/seed-ev-d.json`,
`/tmp/seedwf-counts.json`, sweeps `/tmp/seedcov.json` (before) and `/tmp/seedwf-after.json` (after).
Scripts (outside the repo): `/tmp/inv.mjs`, `/tmp/probeA.mjs`, `/tmp/probeB.mjs`, `/tmp/probeC.mjs`, `/tmp/seedA.mjs`, `/tmp/seedD.mjs`, `/tmp/seedE.mjs`, `/tmp/seedF.mjs`, `/tmp/seedG.mjs`, `/tmp/seedH.mjs`.
No source file was edited, so `npm run build` was not required; `dist/` from the existing build was used.

## 1. Coverage before / after

`node scripts/live-coverage.mjs --json /tmp/seedcov.json` (before) and `... --json /tmp/seedwf-after.json` (after).
Whole registry: before `{DRY_OK 51, LIVE_OK 61, SKIP 97, LIVE_REFUSED 15, THREW 1}`; after `{DRY_OK 51, LIVE_OK 63, SKIP 95, LIVE_REFUSED 15, THREW 1}`.
Assigned resources (68 registry rows): before `{SKIP 39, DRY_OK 11, LIVE_OK 11, LIVE_REFUSED 7}` -> after `{SKIP 37, DRY_OK 11, LIVE_OK 13, LIVE_REFUSED 7}`.

Read that number carefully: **the sweep is data-dependent.** It was re-run AFTER cleanup, so it again sees an empty
tenant and re-marks most of my operations SKIP ("no live row"). That is itself the cleanup proof. While the seeds
existed I exercised the operations directly; the direct evidence is section 3 (111 recorded steps, 68 distinct
successful live calls). The only two rows the sweep keeps as LIVE_OK are `exports.get` and `exports.resolve`, because
my export job record cannot be deleted (section 6, defect D6).

## 2. Seed order used, and what was created then deleted

| Step | Call | Created | Id | Deleted |
|---|---|---|---|---|
| 1 | `hudu.labelTypes.create({name:"ZZ Seed Label Type",color:"#336699",applicable_record_types:["Asset"]})` | label_type | 1 | yes |
| 2 | `hudu.labels.create({label_type_id:1,labelable_type:"Asset",labelable_id:355})` | label | 1 | yes |
| 3 | `hudu.procedures.create({name:"ZZ Seed Procedure",company_id:13,description:...})` | procedure (process) | 4 | yes |
| 4 | `hudu.procedureTasks.create({procedure_id:4,name:"ZZ Seed Task",position:1})` | procedure_task | 3 | yes |
| 5 | `hudu.procedures.duplicate(4,{company_id:13,name:"ZZ Seed Procedure Copy"})` | procedure | 5 | yes |
| 6 | `hudu.procedures.kickoff(4,{name:"ZZ Seed Run"})` | procedure (run) | 6 | cascade with 4 |
| 7 | `hudu.procedures.create({name:"ZZ Seed Global Template"})` (no company_id) | global template | 7 | yes |
| 8 | `hudu.procedures.createFromTemplate(7,{company_id:13,name:"ZZ Seed From Template"})` | procedure | 8 | yes |
| 9 | `hudu.magicDash.create({title:"ZZ Seed Dash",company_name:"Amazon Web Services",message:"m"})` | magic_dash | 3 | yes |
| 10 | `hudu.magicDash.create({title:"ZZ Seed Dash B",company_name:"Amazon Web Services",message:"m2"})` | magic_dash | 4 | yes |
| 11 | `hudu.assets.create(13,{name:"ZZ Seed Expiring Asset",asset_layout_id:2,primary_serial:"ZZSEED1",custom_fields:[{expiration_date:"2027/03/01"}]})` | asset (parent for labels/expirations) | 355 | yes |
| 12 | `hudu.photos.create({file:File("zz-seed.png",image/png),caption:"ZZ Seed Photo",photoable_type:"Company",photoable_id:13})` | photo | 1 | yes |
| 13 | `hudu.uploads.upload(File("zz-seed-upload.txt"),{uploadable_id:355,uploadable_type:"Asset"})` | upload | 1 | yes |
| 14 | `hudu.publicPhotos.create({photo:File,record_type:"Company",record_id:13})` | public_photo | 1 | **NO - impossible** |
| 15 | `hudu.exports.create({format:"csv",company_id:13,include_passwords:false,include_websites:false})` | export job | 2 | **NO - no delete path** |

## 3. Per-operation evidence

Every status below is a real call against the live tenant. `dry` = `{dryRun:true}` as the LAST (options) argument.

| Resource | Operation | Status | Exact command | Evidence |
|---|---|---|---|---|
| procedures | list | LIVE_OK | `for await (p of hudu.procedures.list({company_id:13}))` | 1 row, id 4 |
| procedures | listAll | LIVE_OK | `hudu.procedures.listAll({company_id:13})` | 1 row, id 4 |
| procedures | listPages | LIVE_OK | `for await (pg of hudu.procedures.listPages({company_id:13}))` | `{items:[{id:4,...}], ...}` |
| procedures | get | LIVE_OK | `hudu.procedures.get(4)` | id 4, slug 8e53250db9d2, object_type `Process`, run `false` |
| procedures | create | DRY_OK then LIVE_OK | `hudu.procedures.create({name,company_id:13,description},{dryRun:true})` then real | DryRunResult: `wouldApply:true, impact{affected:1,scope:single,reversible:true}, checks:[payload-present ok], simulated:true`; real -> id 4 |
| procedures | create (global template) | LIVE_OK | `hudu.procedures.create({name:"ZZ Seed Global Template"})` | id 7, `company_id: null` (this is what `createFromTemplate` requires) |
| procedures | update | DRY_OK + OK + GUARD | `hudu.procedures.update(4,{name:"ZZ Seed Procedure v2"},{dryRun:true})`; `{expectedUpdatedAt:"2000-01-01T00:00:00.000Z"}`; `{expectedUpdatedAt:"2026-09-13T02:54:36.778Z"}` | dry `wouldApply:true`; stale -> `STALE_OBJECT`; re-read still `ZZ Seed Procedure` (write did NOT land); fresh -> name `ZZ Seed Procedure v2`, `updated_at` 02:56:24.202Z |
| procedures | duplicate | LIVE_OK | `hudu.procedures.duplicate(4,{company_id:13,name:"ZZ Seed Procedure Copy"})` | new id 5 |
| procedures | kickoff | LIVE_OK | `hudu.procedures.kickoff(4,{name:"ZZ Seed Run"})` | `{procedure:{id:6,...}}` (run) |
| procedures | createFromTemplate | REFUSED then LIVE_OK | `hudu.procedures.createFromTemplate(4,{company_id:13,name:"ZZ Seed From Template"})`; then `...createFromTemplate(7,{company_id:13,...})` | REFUSED (422) `Source must be a global template (company_id: null). Use /duplicate for company-specific processes.`; with the global template -> new id 8 |
| procedures | resolve | LIVE_OK | `hudu.procedures.resolve({name:"ZZ Seed Procedure",company_id:13})` | `{id:4,name:"ZZ Seed Procedure",slug:...,company_id:13,company_name:"Amazon Web Services",...}` |
| procedures | getWithTasks | LIVE_OK | `hudu.procedures.getWithTasks(4)` | `{procedure:{id:4,...}, tasks:[...], task_count:N}` |
| procedures | delete | LIVE_OK | `hudu.procedures.delete(4)` / `(5)` / `(7)` / `(8)` | all resolved OK (void); 6 -> NOT_FOUND because deleting parent 4 cascaded the run |
| procedure_tasks | list / listAll / listPages | LIVE_OK | `hudu.procedureTasks.list({procedure_id:4})`, `.listAll({procedure_id:4})`, `.listPages({procedure_id:4})` | id 3 in each |
| procedure_tasks | get | LIVE_OK | `hudu.procedureTasks.get(3)` | id 3, position 1, priority `unsure` |
| procedure_tasks | create | THREW then LIVE_OK | `hudu.procedureTasks.create({procedure_id:4,name:"ZZ Seed Task",position:1,priority:"high"},{dryRun:true})` then without `priority` | dry OK; real -> THREW 422 `cannot set run-only fields (priority) on process tasks. These fields only apply to run tasks.`; without `priority` -> id 3 |
| procedure_tasks | update | DRY_OK + GUARD-UNAVAILABLE + OK | `hudu.procedureTasks.update(3,{name:"ZZ Seed Task v2"},{dryRun:true})`; `{expectedUpdatedAt:"2000-01-01T00:00:00.000Z"}`; no-guard real | dry `wouldApply:true`; stale -> THREW `assertNotStale: the current procedure_tasks record for 3 carries no updated_at, so the expectedUpdatedAt guard cannot be verified`; no-guard update -> `ZZ Seed Task v2` (defect D3) |
| procedure_tasks | resolve | LIVE_OK | `hudu.procedureTasks.resolve(3)` | `ProcedureTaskSummary` id 3 with procedure_id 4 |
| procedure_tasks | delete | LIVE_OK + REFUSED | `hudu.procedureTasks.delete(3)` / `(4)`; `hudu.procedureTasks.delete(5)` | 3,4 -> OK (void); 5 (a run task) -> REFUSED 422 `Cannot delete tasks from runs. Tasks can only be deleted from processes.` |
| labels | create | DRY_OK then LIVE_OK | `hudu.labels.create({label_type_id,labelable_type,labelable_id},{dryRun:true})` then real | dry `wouldApply:true, reversible:true`; real -> id 1 (Asset:355) |
| labels | get | LIVE_OK | `hudu.labels.get(1)` | `{id:1,label_type_id:1,labelable_type:"Asset",labelable_id:355,user_id:null}` |
| labels | list / listAll | LIVE_OK | `hudu.labels.listAll()` | 1 row (id 1) |
| labels | update | DRY_OK + OK + GUARD | `hudu.labels.update(1,{labelable_id:13},{dryRun:true})`; `{expectedUpdatedAt:"2000-01-01T00:00:00.000Z"}`; fresh | dry `wouldApply:true`; stale -> `STALE_OBJECT` (`found ...`); re-read `labelable_id: 355` (unchanged); fresh -> `labelable_id: 13` |
| labels | resolve | LIVE_OK | `hudu.labels.resolve(1)` | `{id:1,label_type_id:1,labelable_type:"Asset",labelable_id:13,...}` |
| labels | findByLabelable | LIVE_OK | `hudu.labels.findByLabelable("Asset",355)` | `[]` while the label pointed at Asset:13; `[id 1]` after re-targeting to Asset:355 (helper works, it is filtered by the exact pair) |
| labels | delete | LIVE_OK | `hudu.labels.delete(1)` | void, row gone |
| label_types | create | THREW x2 then LIVE_OK | `hudu.labelTypes.create({name,color,slug},{dryRun:true})` then real (no `applicable_record_types`); then `applicable_record_types:["Company"]`; then `["Asset"]` | 422 `Applicable record types can't be blank`; 422 `Applicable record types contains invalid record types: Company`; `["Asset"]` -> id 1 (defect D1) |
| label_types | get / list / listAll / listPages | LIVE_OK | `hudu.labelTypes.get(1)`, `.listAll()`, `for await (x of hudu.labelTypes.list())`, `.listPages()` | id 1 in each |
| label_types | update | DRY_OK + OK + GUARD | `hudu.labelTypes.update(1,{color:"#112233"},{dryRun:true})`; `{expectedUpdatedAt:"2000-01-01T00:00:00.000Z"}`; fresh | dry `wouldApply:true`; stale -> `STALE_OBJECT`; re-read colour still `#336699`; fresh -> `#112233` |
| label_types | resolve | LIVE_OK | `hudu.labelTypes.resolve(1)` and `hudu.labelTypes.resolve({name:"ZZ Seed Label Type"})` | both -> LabelTypeSummary id 1 |
| label_types | delete | LIVE_OK | `hudu.labelTypes.delete(1)` | void, `listAll()` empty after |
| magic_dash | create | DRY_OK + THREW + LIVE_OK | `{dryRun:true}`; then `{title,company_id:13,message,shade:"success"}`; then `{title,company_name:"Amazon Web Services",message}` | dry `wouldApply:true`; company_id-only -> THREW 500 `Internal Server Error` (also with `{title,company_id}` only); `company_name` -> id 3, then id 4 (defect D2) |
| magic_dash | list / listAll | LIVE_OK | `hudu.magicDash.listAll({company_id:13})` | 2 rows (ids 3,4) before delete; `[]` after |
| magic_dash | updatePositions | LIVE_OK | `hudu.magicDash.updatePositions({company_id:13,positions:[{id:3,position:2},{id:4,position:1}]})` | `{"success":true}` |
| magic_dash | delete | LIVE_OK | `hudu.magicDash.delete({title:"ZZ Seed Dash",company_name:"Amazon Web Services"})` | void; id 3 gone from `listAll` |
| magic_dash | deleteById | LIVE_OK | `hudu.magicDash.deleteById(4)` | void; `listAll` -> `[]` |
| magic_dash | findByCompany | **UNVERIFIED** | not called while a row existed | same read route as `listAll({company_id})` (LIVE_OK), but the helper itself was not called live; after cleanup no row exists to call it on |
| magic_dash | resolve | **UNVERIFIED** | not called while a row existed | idem (no live row at read time) |
| photos | create | DRY_OK + THREW + LIVE_OK | `{dryRun:true}`; then `{file,caption,company_id:13,photoable_type:"Company",photoable_id:13}`; then `{file:image/png,caption,photoable_type:"Company",photoable_id:13}` | dry checks `file-present ok, caption-present ok, photoable-pair ok`; real -> 422 `errors:["File type must be one of: image/jpeg, image/png, image/gif, image/webp, image/heic","Photoable must exist","Company cannot be set directly. Change the photoable to update the company."]`; fixed payload -> id 1 (defect D4) |
| photos | get | LIVE_OK | `hudu.photos.get(1)` | id 1, caption `ZZ Seed Photo`, photoable Company:13 |
| photos | list / listAll / listPages | LIVE_OK | `hudu.photos.listAll({company_id:13})`, `.list({company_id:13})`, `.listPages({company_id:13})` | 1 row (id 1) |
| photos | update | DRY_OK + OK + GUARD | `hudu.photos.update(1,{caption:"ZZ Seed Photo v2"},{dryRun:true})`; `{expectedUpdatedAt:"2000-01-01T00:00:00.000Z"}`; fresh | dry `wouldApply:true`; stale -> `STALE_OBJECT (found 2026-09-13T02:54:37.100Z)`; re-read caption still `ZZ Seed Photo`; fresh -> `ZZ Seed Photo v2` |
| photos | findByPhotoable | LIVE_OK | `hudu.photos.findByPhotoable("Company",13)` | 1 row (id 1) |
| photos | resolve | LIVE_OK | `hudu.photos.resolve(1)` | PhotoSummary id 1 |
| photos | delete | LIVE_OK | `hudu.photos.delete(1)` | void, `listAll` empty after |
| uploads | upload | DRY_OK + THREW + LIVE_OK | `{dryRun:true}`; `{uploadable_id:13,uploadable_type:"Company"}`; `{uploadable_id:355,uploadable_type:"Asset"}` | dry checks `file-present ok, upload-target ok`; `Company` -> 422 `Uploadable type is not included in the list`; `Asset`+existing asset -> id 1 (`zz-seed-upload.txt`, `text/plain`, `17 Bytes`) (defect D5) |
| uploads | list / listAll / listPages | LIVE_OK | `hudu.uploads.listAll()`, `.list()`, `.listPages()` | 1 row (id 1) |
| uploads | get | LIVE_OK | `hudu.uploads.get(1)` | metadata row (not the blob; `{download:true}` not used) |
| uploads | resolve | LIVE_OK | `hudu.uploads.resolve(1)` | UploadSummary `{name:"zz-seed-upload.txt",ext:"txt",mime:"text/plain",size:"17 Bytes"}` |
| uploads | delete | LIVE_OK | `hudu.uploads.delete(1)` | void, `listAll` empty after |
| public_photos | create | DRY_OK + LIVE_OK (executed!) | `hudu.publicPhotos.create({photo:File,record_type:"Company",record_id:13},{dryRun:true})` then real | dry `wouldApply:true, impact{reversible:false}` + warning "the API exposes no delete path for a public photo, so this create cannot be undone"; real -> `{id:"d0f95dd9dad4",numeric_id:1}`, file_name `RackMultipart...png` |
| public_photos | get | LIVE_OK | `hudu.publicPhotos.get(1)` | id `d0f95dd9dad4`, numeric_id 1 |
| public_photos | list / listAll / listPages | LIVE_OK | `hudu.publicPhotos.listAll()`, `.list()`, `.listPages()` | 1 row |
| public_photos | update | LIVE_OK | `hudu.publicPhotos.update(1,{record_type:"Company",record_id:13})` | row returned unchanged (`PublicPhotoUpdate` carries only record_type/record_id) |
| public_photos | resolve | LIVE_OK | `hudu.publicPhotos.resolve(1)` | PublicPhoto by numeric_id |
| public_photos | delete | REFUSED (does not exist) | `fetch(base+"/public_photos/1",{method:"DELETE",headers:{"x-api-key":...}})`; `typeof hudu.publicPhotos.delete` | raw DELETE -> HTTP 404 (HTML "404" page); SDK has no delete method (`undefined`). Irreversible (defect D6) |
| exports | create | DRY_OK + LIVE_OK | `hudu.exports.create({format:"csv",company_id:13,include_passwords:false,include_websites:false},{dryRun:true})` then real | dry `wouldApply:true, impact{reversible:false}` + warnings "POST /exports returns an empty 200 body" / "no cancel or delete path"; real -> void (200 empty body); job then appears as export id 2 |
| exports | list / listAll | LIVE_OK | `hudu.exports.listAll()`, `for await (x of hudu.exports.list())` | 0 rows before, 1 row after (id 2, account_id 1) |
| exports | get | THREW then LIVE_OK | `hudu.exports.get(1)`; `hudu.exports.get(2)` | id 1 does not exist -> NOT_FOUND (body `{"errors":["Export file not available"]}`); id 2 -> the live export record. **GET is NOT always 404** (contradicts the brief) |
| exports | resolve | THREW then LIVE_OK | `hudu.exports.resolve(1)`; sweep resolved id 2 | id 1 -> NOT_FOUND; id 2 -> OK (sweep row `exports.resolve` = LIVE_OK, "called with 2") |
| expirations | list / listAll / listPages | LIVE_OK | `hudu.expirations.list({company_id:13})`, `.listAll()`, `.listPages()` | 3 rows, ids 1-3 (pre-existing, unchanged) |
| expirations | resolve | LIVE_OK (read-only, pre-existing row) | `hudu.expirations.resolve(1)` | `{id:1,expiration_type:"ssl_certificate",expirationable_type:"Website",expirationable_id:1,company_id:13,date:"2026-11-02"}` |
| expirations | findByResource | LIVE_OK (read-only, pre-existing row) | `hudu.expirations.findByResource("Website",1)` | 2 rows (ssl_certificate + domain) |
| expirations | update | **UNVERIFIED** | not run against a mutable row | there is no `POST /expirations`; the only route to a new expiration is an asset-layout field of type `Expiration`, and `assetLayouts.create` returns 500 for every payload I tried (D7). Mutating a pre-existing row would break the "unchanged" rule |
| expirations | delete | **UNVERIFIED** | idem | idem |
| matchers | list / listAll | REFUSED (CONFIG_ERROR) | `hudu.matchers.listAll({integration_id:1})` | THREW `CONFIG_ERROR: No matching integration` (vendor body `{"error":"No matching integration"}`). Tenant has no integrations |
| matchers | resolve | REFUSED (CONFIG_ERROR) | `hudu.matchers.resolve(1)` | THREW `matchers.resolve accepts a sync_id, an identifier or an id, each with the integration_id the vendor requires - pass an object ...` |
| matchers | update | THREW 500 | `hudu.matchers.update(1,{identifier:"x"})` | 500 `Internal Server Error` (no row / no integration) |
| matchers | delete | THREW 500 | `hudu.matchers.delete(1)` | 500 `Internal Server Error` |
| matchers | findBySyncId | REFUSED (CONFIG_ERROR) | `hudu.matchers.findBySyncId(1,1)` | THREW `CONFIG_ERROR: No matching integration` |
| (parent) | assets.create | LIVE_OK | `hudu.assets.create(13,{name:"ZZ Seed Expiring Asset",asset_layout_id:2,primary_serial:"ZZSEED1",custom_fields:[{expiration_date:"2027/03/01"}]})` | id 355. Note: the vendor body came back **wrapped** (`{"asset":{...}}`) although the client casts it flat (incidental defect D8) |
| (parent) | assets.delete (cleanup) | LIVE_OK | `hudu.assets.delete(13,355)` | void, company 13 now has 0 assets |

## 4. Guard proofs (`expectedUpdatedAt`)

| Resource | Stale -> STALE_OBJECT | Write did not land (re-read) | Fresh -> allowed |
|---|---|---|---|
| procedures | yes (`expected 2000-01-01..., found 2026-09-13T02:54:36.778Z`) | yes, name stayed `ZZ Seed Procedure` | yes, `updated_at` moved to 02:56:24.202Z |
| label_types | yes | yes, colour stayed `#336699` | yes, colour -> `#112233` |
| labels | yes | yes, `labelable_id` stayed 355 | yes, `labelable_id` -> 13 |
| photos | yes | yes, caption stayed `ZZ Seed Photo` | yes, caption -> `ZZ Seed Photo v2` |
| procedure_tasks | **no guard exists** - `assertNotStale` throws because the record carries no `updated_at`; the update then lands unguarded | n/a (no stale check possible) | yes, name -> `ZZ Seed Task v2` |
| expirations | UNVERIFIED (no row I was allowed to mutate) | n/a | n/a |
| magic_dash / uploads / public_photos / matchers | n/a - these resources expose no `update` (magic_dash has `updatePositions` only; uploads has no update; public_photos.update carries only record_type/record_id) | n/a | n/a |

## 5. Cleanup

Children first: `procedure_tasks.delete` (3,4) -> `procedures.delete` (4,5,7,8) -> `labels.delete(1)` -> `label_types.delete(1)`
-> `photos.delete(1)` -> `uploads.delete(1)` -> `magic_dash.delete` + `deleteById` (3,4) -> `assets.delete(13,355)`.
Procedure run 6 and its task 5 disappeared with the cascade from process 4 (`procedures.delete(6)` then answered NOT_FOUND
and `procedure_tasks.delete(5)` was refused because run tasks cannot be deleted directly).

Final inventory (`node /tmp/seedH.mjs`, counts in `/tmp/seedwf-counts.json`):

| Resource | Count now | Pre-existing baseline | Verdict |
|---|---|---|---|
| procedures | 0 | 0 | clean |
| procedure_tasks | 0 | 0 | clean |
| magic_dash | 0 | 0 | clean |
| photos | 0 | 0 | clean |
| uploads | 0 | 0 | clean |
| labels | 0 | 0 | clean |
| label_types | 0 | 0 | clean |
| expirations | 3 (ids 1,2,3; dates/updated_at untouched) | 3 (not in the brief's list) | unchanged |
| **public_photos** | **1 (numeric_id 1, MINE)** | 0 | **CANNOT DELETE - API has no delete path** |
| **exports** | **1 (id 2, MINE)** | 0 | **CANNOT DELETE - API has no cancel/delete path** |
| companies | 21 | 21 | unchanged |
| articles | 4 | 4 | unchanged |
| asset_layouts | 4 (ids 1,2,3,5) | 4 | unchanged |
| websites | 2 (ids 1,2) | 2 | unchanged |
| groups / users / lists / folders / networks | 1 / 1 / 1 / 1 / 1 | same | unchanged |
| assets (company 13) | 0 | 0 | clean |
| activity_logs (company 13) | 466 | 466 (stated) | no rows removed; count equals the stated baseline |

## 6. Defects and findings (with repro)

- **D1 `label_types.create` needs `applicable_record_types`, and `Company` is not a valid value.** `hudu.labelTypes.create({name,color,slug})` -> 422 `Applicable record types can't be blank`; `applicable_record_types:["Company"]` -> 422 `Applicable record types contains invalid record types: Company`; `["Asset"]` -> 201. The SDK type/`docs` give no enum, so an agent guessing from the resource name fails. Repro: `/tmp/seedD.mjs` step 1.
- **D2 `magic_dash.create` with `company_id` -> HTTP 500.** `hudu.magicDash.create({title,company_id:13,message,shade:"success"})` and the minimal `{title,company_id:13}` both return `500 Internal Server Error`; the same call with `company_name:"Amazon Web Services"` instead of `company_id` -> 201. The SDK's `MagicDashCreate` (and `MagicDash.company_id`) invites the failing shape. Repro: `/tmp/probeC.mjs`, `/tmp/seedF.mjs`.
- **D3 `procedure_tasks` has NO `expectedUpdatedAt` guard.** `hudu.procedureTasks.update(3,{name:"..."},{expectedUpdatedAt:"2000-01-01T00:00:00.000Z"})` throws `assertNotStale: the current procedure_tasks record for 3 carries no updated_at, so the expectedUpdatedAt guard cannot be verified`, and the unguarded update then succeeds. A caller who sets the guard gets an exception instead of protection; the vendor GET simply omits `updated_at`.
- **D4 `photos.create` rejects a `Company` photoable pair it also demands.** `{company_id:13,photoable_type:"Company",photoable_id:13}` -> 422 `Photoable must exist` + `Company cannot be set directly. Change the photoable to update the company.`. It works only with an image mime type and no `company_id`; the dry-run checks pass for the payload the server rejects. Repro: `/tmp/probeC.mjs`.
- **D5 `uploads.upload` rejects `uploadable_type:"Company"`.** -> 422 `Uploadable type is not included in the list`. `Asset` (with an existing asset id) is accepted; `Article`/`Website`/`Procedure` are accepted types whose ids must also exist (`Uploadable must exist`). There is no enum in `api-docs.json`, so the allowed set is undiscoverable without trial. Repro: `/tmp/probeC.mjs`, `/tmp/seedD.mjs`.
- **D6 Two writes cannot be undone through the API.** (a) `POST /public_photos` has no `DELETE`: raw `DELETE {base}/public_photos/1` -> HTTP 404 and `hudu.publicPhotos.delete` is `undefined`; my seeded public photo (numeric_id 1) stays in the tenant. (b) `POST /exports` has no cancel/delete: my export job (id 2) stays. Both dry-runs correctly report `impact.reversible:false`, so the client warns honestly; the leak is the vendor's. **This is the only residue from this run.**
- **D7 `asset_layouts.create` returns 500 for every payload tried** (name only; name+icon+colour; with a `Date` field; with an `Expiration` field; with `fields_attributes`). This closes the only route by which the API can mint a new expiration, so `expirations.update`/`delete` could not be exercised without mutating pre-existing tenant rows. Repro: `/tmp/seedF.mjs`, `/tmp/seedG.mjs`.
- **D8 (incidental, assets) `assets.create` returns the body wrapped in `{asset:{...}}`** while `AssetsResource.create` casts the raw body to a flat `Asset` (`dist/.../assets.ts`: "The 201 response is a flat Asset"). Live: `hudu.assets.create(13,{...})` -> `{"asset":{"id":355,...}}`, so `asset.id` is `undefined` for a caller. Not my resource, but it broke my seeding until I used `a?.asset?.id`.
- **D9 (brief correction) `exports` GET is not "always 404".** `hudu.exports.get(2)` and the sweep's `exports.resolve` on the live id both succeed and return the export job record; only a non-existent id fails (`{"errors":["Export file not available"]}`). Exports are write-only in the sense that they cannot be deleted, not in the sense that they cannot be read.

## 7. UNVERIFIED (with reasons)

1. `expirations.update`, `expirations.delete` - no `POST /expirations`; the only creation route is an `Expiration`-type asset-layout field and `assetLayouts.create` fails with 500 (D7); the only existing rows are pre-existing data that must survive unchanged.
2. `magic_dash.findByCompany`, `magic_dash.resolve` - not called while my rows existed; after cleanup the tenant holds no magic_dash row.
3. All `matchers` operations other than `list`/`listAll` (REFUSED with `CONFIG_ERROR: No matching integration`) and `resolve` (CONFIG_ERROR guidance): this tenant has no integration, so no matcher row can exist. `update`/`delete` were attempted against id 1 and answered 500.
4. `public_photos.delete` - the operation does not exist in the API (404 on raw DELETE, no SDK method). It can never be covered; it is a defect, not a gap in this run.
5. `uploads.get({download:true})`, `photos.get({download:true})` - blob download not exercised (metadata form covered).
