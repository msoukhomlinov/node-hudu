# Fix: dangling prose references in the capability registry, + the `prose-dangling` gate

Run: node-hudu @ `1080acc` on `feat/agent-execution-layer` (working tree; nothing committed by this task).
Scan script: `/tmp/probeX.mjs` (coordinator's; reads `dist/` + `CAPABILITY_REGISTRY`, regex `\b([a-z_]+)\.([a-zA-Z][A-Za-z0-9_]*)\b` over `preferredWhen|usage|purpose`).

## Result in one line

**Scan before: 51 dangling prose references (name with no such METHOD on the client) → after: 0.**
All 51 were template artefacts in `capabilities.plan.json` (`metadata.preferredWhen`), not a missing feature:
no plan row ever declared `<res>.search` / `<res>.archive` / `<res>.get` / `<res>.update` for those resources,
and `api-docs.json` exposes no such endpoint. Fix: **33 x option (a)** (point at the operation that exists),
**18 x option (b)** (reword so no non-existent operation is named). **0 escalated** under option (c); see
"Escalation / for the coordinator" for two observations that are *not* prose defects.

## Files changed (all by this task)

| file | change |
|---|---|
| `capabilities.plan.json` | 51 prose strings rewritten in place (51 insertions / 51 deletions — one line per case) |
| `src/capabilities.ts`, `capabilities.json`, `MCP_TOOL_MANIFEST.md` | regenerated (`npm run capabilities:build`, `npm run mcp:project`) |
| `scripts/check-capabilities.mjs` | new rule `prose-dangling` (+33 lines, doc header updated) |

`src/**` runtime code was not touched; no public surface, no dependency and no threshold changed.

## Evidence used to decide each case (not guessed)

1. **Client surface** — the same "does the client have this method" answer the checker uses: public method
   declarations in `src/resources/<res>.ts` (`sourceMethod`, which excludes `private`/`protected`). Cross-checked
   with a runtime walk of every resource prototype (`/tmp/methodsX.mjs`).
2. **Vendor contract** — `api-docs.json`. Archive is the decisive one: only **8** paths contain `archive`
   (`articles`, `asset_passwords`, `assets`, `companies` x archive/unarchive). So for every other resource the
   SDK has no archive to point at *because the vendor has none for them* — option (c) does not apply.

Relevant endpoint facts checked one by one:
`/cards/*` = `lookup`, `jump` only (no `/cards/{id}`); `/expirations/{id}` = `PUT`+`DELETE` (no `GET`, and the
plan's own test is titled "fetches by id without a scan"); `/exports/{id}` = `GET` only; `/relations/{id}` =
`DELETE` only; `POST /magic_dash` is summarised "Create or update a Magic Dash Item" and its DELETE is documented to
take the same `title`+`company_name` as the create; `uploads` has `upload` (POST) and `delete` but no public
`update`.

3. **Existing valid prose as the style baseline** — `companies.list`/`articles.list` ("prefer X.search or X.resolve"),
   `companies.delete` ("Irreversible; prefer companies.archive ...") are *correct* rows because `search`/`archive`
   really exist there; the 51 broken rows were those templates copied onto resources without the method.

## Decision table (51/51)

Column 4 is the option applied; column 5 says why.

| operation | field | referenced (dangling) | option | why | new text |
|---|---|---|---|---|---|
| `activity_logs.list` | `preferredWhen` | `activity_logs.search` | (a) | real server-filtered helper exists on the same resource (returns several rows for one parent); sentence names it plus resolve | `Use when many records are needed; prefer activity_logs.findByResource for one resource's entries, or activity_logs.resolve for a single lookup.` |
| `asset_layouts.list` | `preferredWhen` | `asset_layouts.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer asset_layouts.resolve for a single lookup.` |
| `cards.jump` | `preferredWhen` | `cards.get` | (b) | no /cards/{id} path in api-docs.json (only /cards/lookup and /cards/jump) and no public cards.get(); clause replaced with the real lookup path | `Preferred when the caller has an integration identifier instead of a Hudu id; Hudu exposes no card read by id, so cards.lookup is the JSON path for the same identifiers.` |
| `expirations.delete` | `preferredWhen` | `expirations.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer expirations.update when the record may be needed again.` |
| `expirations.list` | `preferredWhen` | `expirations.search` | (a) | real server-filtered helper exists on the same resource (returns several rows for one parent); sentence names it plus resolve | `Use when many records are needed; prefer expirations.findByResource for one resource's expirations, or expirations.resolve for a single lookup.` |
| `expirations.resolve` | `preferredWhen` | `expirations.get` | (b) | no public expirations.get() and no GET /expirations/{id} path (only PUT/DELETE); resolve itself handles a known id (test: "fetches by id without a scan") | `Use when the identifier is a resource pair; a known id is resolved directly, without a scan.` |
| `exports.create` | `preferredWhen` | `exports.update` | (b) | /exports/{id} advertises GET only, so there is no export update to prefer; clause dropped | `Only for a new export request; Hudu exposes no update for an existing export.` |
| `exports.list` | `preferredWhen` | `exports.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer exports.resolve for a single lookup.` |
| `flag_types.delete` | `preferredWhen` | `flag_types.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer flag_types.update when the record may be needed again.` |
| `flag_types.list` | `preferredWhen` | `flag_types.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer flag_types.resolve for a single lookup.` |
| `flags.delete` | `preferredWhen` | `flags.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer flags.update when the record may be needed again.` |
| `flags.list` | `preferredWhen` | `flags.search` | (a) | real server-filtered helper exists on the same resource (returns several rows for one parent); sentence names it plus resolve | `Use when many records are needed; prefer flags.findByFlagable for one record's flags, or flags.resolve for a single lookup.` |
| `folders.delete` | `preferredWhen` | `folders.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer folders.update when the record may be needed again.` |
| `folders.list` | `preferredWhen` | `folders.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer folders.resolve for a single lookup.` |
| `ip_addresses.delete` | `preferredWhen` | `ip_addresses.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer ip_addresses.update when the record may be needed again.` |
| `ip_addresses.list` | `preferredWhen` | `ip_addresses.search` | (a) | real single-record lookup exists on the same resource (purpose: "Find one ... by its exact ..."); name swapped for it | `Use when many records are needed; prefer ip_addresses.findByAddress or ip_addresses.resolve for a single lookup.` |
| `label_types.delete` | `preferredWhen` | `label_types.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer label_types.update when the record may be needed again.` |
| `label_types.list` | `preferredWhen` | `label_types.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer label_types.resolve for a single lookup.` |
| `labels.delete` | `preferredWhen` | `labels.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer labels.update when the record may be needed again.` |
| `labels.list` | `preferredWhen` | `labels.search` | (a) | real server-filtered helper exists on the same resource (returns several rows for one parent); sentence names it plus resolve | `Use when many records are needed; prefer labels.findByLabelable for one record's labels, or labels.resolve for a single lookup.` |
| `lists.delete` | `preferredWhen` | `lists.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer lists.update when the record may be needed again.` |
| `lists.list` | `preferredWhen` | `lists.search` | (a) | real single-record lookup exists on the same resource (purpose: "Find one ... by its exact ..."); name swapped for it | `Use when many records are needed; prefer lists.findByName or lists.resolve for a single lookup.` |
| `magic_dash.create` | `preferredWhen` | `magic_dash.update` | (b) | no public magic_dash.update(); POST /magic_dash is documented "Create or update a Magic Dash Item" keyed by title + company, so the sentence now states that | `Only for a new item; posting an existing title and company updates that item instead of creating a second one.` |
| `magic_dash.delete` | `preferredWhen` | `magic_dash.archive` | (a) | no magic_dash.archive/update; POST /magic_dash (create) is the only way back to a deleted item | `Irreversible; a deleted item can be re-created with magic_dash.create using the same title and company.` |
| `magic_dash.list` | `preferredWhen` | `magic_dash.search` | (a) | real server-filtered helper exists on the same resource (returns several rows for one parent); sentence names it plus resolve | `Use when many records are needed; prefer magic_dash.findByCompany for one company's items, or magic_dash.resolve for a single lookup.` |
| `matchers.delete` | `preferredWhen` | `matchers.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer matchers.update when the record may be needed again.` |
| `matchers.list` | `preferredWhen` | `matchers.search` | (a) | real server-filtered helper exists on the same resource (returns several rows for one parent); sentence names it plus resolve | `Use when many records are needed; prefer matchers.findBySyncId for the matchers of one sync id, or matchers.resolve for a single lookup.` |
| `networks.delete` | `preferredWhen` | `networks.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer networks.update when the record may be needed again.` |
| `networks.list` | `preferredWhen` | `networks.search` | (a) | real single-record lookup exists on the same resource (purpose: "Find one ... by its exact ..."); name swapped for it | `Use when many records are needed; prefer networks.findByAddress or networks.resolve for a single lookup.` |
| `password_folders.delete` | `preferredWhen` | `password_folders.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer password_folders.update when the record may be needed again.` |
| `photos.delete` | `preferredWhen` | `photos.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer photos.update when the record may be needed again.` |
| `photos.list` | `preferredWhen` | `photos.search` | (a) | real server-filtered helper exists on the same resource (returns several rows for one parent); sentence names it plus resolve | `Use when many records are needed; prefer photos.findByPhotoable for one record's photos, or photos.resolve for a single lookup.` |
| `procedure_tasks.delete` | `preferredWhen` | `procedure_tasks.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer procedure_tasks.update when the record may be needed again.` |
| `procedure_tasks.list` | `preferredWhen` | `procedure_tasks.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer procedure_tasks.resolve for a single lookup.` |
| `procedures.delete` | `preferredWhen` | `procedures.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer procedures.update when the record may be needed again.` |
| `procedures.list` | `preferredWhen` | `procedures.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer procedures.resolve for a single lookup.` |
| `public_photos.list` | `preferredWhen` | `public_photos.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer public_photos.resolve for a single lookup.` |
| `rack_storage_items.delete` | `preferredWhen` | `rack_storage_items.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer rack_storage_items.update when the record may be needed again.` |
| `rack_storage_items.list` | `preferredWhen` | `rack_storage_items.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer rack_storage_items.resolve for a single lookup.` |
| `rack_storages.delete` | `preferredWhen` | `rack_storages.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer rack_storages.update when the record may be needed again.` |
| `rack_storages.list` | `preferredWhen` | `rack_storages.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer rack_storages.resolve for a single lookup.` |
| `relations.create` | `preferredWhen` | `relations.update` | (b) | /relations/{id} advertises DELETE only and there is no public relations.update(); sentence names the only real path (relations.create) | `Only for a new relation; Hudu exposes no relation update, so changing an existing relation means relations.delete followed by relations.create.` |
| `relations.delete` | `preferredWhen` | `relations.archive` | (b) | no relations.archive/update; relations.create is the only way back to a deleted relation | `Irreversible; Hudu exposes no relation update, so a deleted relation can only be re-created with relations.create.` |
| `relations.list` | `preferredWhen` | `relations.search` | (a) | real server-filtered helper exists on the same resource (returns several rows for one parent); sentence names it plus resolve | `Use when many records are needed; prefer relations.findByEndpoints for one record pair's relations, or relations.resolve for a single lookup.` |
| `uploads.delete` | `preferredWhen` | `uploads.archive` | (a) | no uploads.archive and no public uploads.update; uploads.upload (POST /uploads) is the only way to re-store the file | `Irreversible; prefer uploads.upload to store the file again if it is needed later.` |
| `uploads.list` | `preferredWhen` | `uploads.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer uploads.resolve for a single lookup.` |
| `vlan_zones.delete` | `preferredWhen` | `vlan_zones.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer vlan_zones.update when the record may be needed again.` |
| `vlan_zones.list` | `preferredWhen` | `vlan_zones.search` | (b) | no X.search public method, and no server-filtered search helper on that resource; clause dropped, X.resolve kept | `Use when many records are needed; prefer vlan_zones.resolve for a single lookup.` |
| `vlans.delete` | `preferredWhen` | `vlans.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer vlans.update when the record may be needed again.` |
| `vlans.list` | `preferredWhen` | `vlans.search` | (a) | real single-record lookup exists on the same resource (purpose: "Find one ... by its exact ..."); name swapped for it | `Use when many records are needed; prefer vlans.findByVlanId or vlans.resolve for a single lookup.` |
| `websites.delete` | `preferredWhen` | `websites.archive` | (a) | X.update is a real public method (plan row at status tested); the "keep it instead of deleting" advice now names it | `Irreversible; prefer websites.update when the record may be needed again.` |

Option counts: **(a) 33**, **(b) 18**, **(c) 0**.

## The gate: `prose-dangling`

`node scripts/check-capabilities.mjs` now FAILS when a prose field (`purpose`, `usage`, `preferredWhen`) names an
operation the client cannot call. It reuses the existing `sourceMethod()` helper — the same function
`coverage-source-missing` uses — so there is exactly one answer to "does the client have this?".

* rule id: `prose-dangling`
* message shape (operation + field + referenced name, as required):
  `[prose-dangling] operations[122].metadata.preferredWhen: flags.list: preferredWhen tells an agent to call "flags.search", which the client cannot call — no public method search() in src/resources/flags.ts`
* checked on the **plan rows** (the source of truth) and on the **emitted records**
  (`CAPABILITY_REGISTRY['<op>'].<field>`), so a hand-edited generated file cannot smuggle a bad name back in —
  the same two-surface style as `related-dangling`.
* deliberate difference from `related-dangling`: the plan-side scan is **unscoped** (every row, not only the
  `--group`/`--ship` selection). A name the client cannot call is wrong in every group, and a group gate must not
  report a clean pass over prose that is broken elsewhere. Documented in the script's rule header.

## Proof the rule is not vacuous (required)

**(1) Plan side — inject one dangling reference into `capabilities.plan.json`** (`flags.list` → `flags.search`,
the exact original text), then run the default gate:

```
$ node scripts/check-capabilities.mjs ; echo $?
  ✗ [prose-dangling] operations[122].metadata.preferredWhen: flags.list: preferredWhen tells an agent to call "flags.search", which the client cannot call — no public method search() in src/resources/flags.ts
FAIL — 3 failure(s) in 3 distinct rule(s): prose-dangling=1, emission-planhash=1, manifest-planhash=1
1
```
(the other 2 failures are the planHash gates reacting to the injected edit — expected, and they confirm the
injection really landed in the plan). Reference restored afterwards.

**(2) Registry side — hand-edit only the generated `src/capabilities.ts`** (plan untouched, so planHash still matches):

```
$ node scripts/check-capabilities.mjs ; echo $?
  ✗ [prose-dangling] CAPABILITY_REGISTRY['flags.list'].preferredWhen: flags.list: preferredWhen tells an agent to call "flags.search", which the client cannot call — no public method search() in src/resources/flags.ts
FAIL — 1 failure(s) in 1 distinct rule(s): prose-dangling=1
1
```
Restored with `npm run capabilities:build` (the generated file is never hand-edited in the final state).

**(3) Independent before/after of the same rule** — the gate run against a byte copy of the pre-fix plan
(`/tmp/plan.before.json`, kept for the record) reports the defect and nothing else:

```
$ node scripts/check-capabilities.mjs --plan /tmp/plan.before.json
FAIL — 51 failure(s) in 1 distinct rule(s): prose-dangling=51
```
While the post-fix plan reports `PASS — 0 failures`. The 51 count matches the coordinator's scan exactly.

## Gates after the change (all re-run on the final tree)

| command | result |
|---|---|
| `node /tmp/probeX.mjs` | `prose references pointing at a method that does NOT exist on the client: 0` (was 51) |
| `node scripts/check-capabilities.mjs` | exit 0 — `PASS — 0 failures; rows=225 scoped=225 registryRecords=225 warnings=66` |
| `node scripts/check-capabilities.mjs --ship` | exit 0 — `PASS — 0 failures; rows=225 ... warnings=66` |
| `node scripts/project-mcp-tools.mjs --check-example` | exit 0 — `tools checked=147; example/field violations=0` |
| `npm run capabilities:build` | exit 0 — 225 records emitted, `coverage gaps: none` |
| `npm run mcp:project` | exit 0 — 147 tools projected |
| `npm run build` | exit 0 |
| `npm test` | exit 0 — **51 files, 1684 tests passed** (no test weakened, skipped or deleted; no threshold touched) |
| `node scripts/check-capabilities.mjs --plan test/fixtures/capabilities.plan.drifted.json` | exit 1 (unchanged negative fixture; it is a manual fixture, not driven by a vitest test, and still fails by design) |

Warnings stayed at 66 for the plan before and after the fix (`--plan /tmp/plan.before.json` → 66 warnings), so the
prose edits removed nothing but the defect and added no new warning class.

## Escalation / for the coordinator

Nothing was left unfixed under option (c). Two observations that are *not* prose defects, for a separate decision:

1. **`X.update` cannot archive, even where the vendor can.** `PUT /networks/{id}`, `/vlans/{id}`,
   `/vlan_zones/{id}` and `/procedures/{id}` accept `archived: true` in the vendor body, but the SDK's update
   types (`NetworkUpdate = Partial<Network>`, which carries `archived_at`, not `archived`) do not expose it. So for
   those four resources the honest prose now says "prefer X.update when the record may be needed again" instead of
   a false `X.archive`. Declaring an archive helper for them would be a *new feature* (plan rows + helper methods +
   tests), and the plan never declared one — deliberately not done here.
2. **`activity_logs.deleteAll` remains the only bulk delete** (its own prose already says so); the dangling
   reference was only on `activity_logs.list`, not on that row.

## UNVERIFIED

* The 51 rewritten sentences were verified against `api-docs.json`, the public method index and the plan rows, but
  **not** against a live Hudu instance (no live call was needed for a prose fix; the sandbox was not used).
* `check-capabilities.mjs` is a Node script with no unit test of its own; the new rule is proven by the two
  injections above plus the 51-failure run on the pre-fix plan. Nothing else in the repo exercises it programmatically.
