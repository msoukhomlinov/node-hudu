# Defect 3 (resolve filters) + Defect 4 (advertised stale guards)

| # | Defect | Verdict | Live BEFORE | Live AFTER | Registry / plan | Tests |
|---|--------|---------|-------------|------------|-----------------|-------|
| 3a | `groups.resolve('<slug>')` / `{slug}` false null | FIXED (client scan) | null | group id 1 | usage prose corrected | yes |
| 3b | `users.resolve('<slug>')` / `{slug}` false null | FIXED (client scan) | null | user id 1 | usage prose corrected | yes |
| 3c | `users.resolve('Max Soukhomlinov')` false null | FIXED (`last_name` + client-scan fallback) | null | user id 1 | usage prose corrected | yes |
| 3d | other resolve/findBy filters audited against the vendor | AUDITED (no other live-provable mismatch) | — | — | — | n/a |
| 4a | `rack_storages.update` advertises unreachable `STALE_OBJECT` | FIXED: refuse accurately | CONFIG_ERROR after a GET | CONFIG_ERROR before any request | staleCheck `unavailable`, STALE_OBJECT removed | yes |
| 4b | `ip_addresses.update` refuses with a false reason | FIXED: guard supported | CONFIG_ERROR "no updated_at" | STALE_OBJECT / LIVE_OK | staleCheck `updated_at`, STALE_OBJECT added | yes |
| 4c | `procedure_tasks.update` same class as 4a | FIXED: refuse accurately | CONFIG_ERROR after a GET | refusal before any request (unit-verified) | staleCheck `unavailable`, STALE_OBJECT removed | yes |
| 4d | `magic_dash.updatePositions` | NO DEFECT FOUND | no updated_at live, no STALE_OBJECT advertised | unchanged | unchanged | n/a |

(all sections below are filled in; see "Evidence" for the exact commands and observed output)

## Environment and scope

- Tenant: `https://hudu-sandbox.example.com`, Hudu `2.45.1` (`api-docs.json` spec version), dates UTC 2026-09-12/13.
- Repo `/Users/maxs/gitrepos/node-hudu`, branch `feat/agent-execution-layer` (never switched, nothing committed).
- Every live record created for this work was deleted; the **FINAL INVENTORY** below proves the tenant is back to baseline.

## DEFECT 3 — `resolve` false nulls from a vendor filter the vendor does not match

### 3.0 The live fixtures (read, not created)

```
node /tmp/probe-defect3.mjs
group record: {"id":1,"name":"Default Group","slug":"9fd63e9f4ca2",...}
user  record: {"id":1,"email":"user@example.com","first_name":"Max","last_name":"Soukhomlinov","slug":"0000000000",...}
```

### 3.1 BEFORE (the defect)

```
groups.resolve(slug)                     OK null
groups.resolve({slug})                   OK null
groups.listAll({slug})                   OK "1 rows: 1"
groups.listAll({search})                 OK "0 rows: "
users.resolve(slug)                      OK null
users.resolve({slug})                    OK null
users.resolve(name)                      OK null      <-- 'Max Soukhomlinov'
users.listAll({search:Soukhomlinov})     OK "1 rows: 1"
```

### 3.2 The confound in the seeder's evidence — `?slug=` is IGNORED, not honoured

A filter-honoured matrix was run with `page_size=250` and a **bogus** value: `n=0` means the
vendor applied the filter, `n=<total>` means the key is ignored and the whole collection comes back.

```
node /tmp/probe-filters2.mjs
companies          21 slug:HONORED  name:HONORED  domain:IGNORED  search:HONORED
articles            4 slug:HONORED  name:HONORED  search:HONORED
asset_layouts       4 slug:HONORED  name:HONORED  search:IGNORED
websites            2 slug:HONORED  name:HONORED  search:HONORED
groups              1 slug:IGNORED  name:HONORED  search:HONORED
users               1 slug:IGNORED  search:HONORED  email:HONORED  first_name:HONORED  last_name:HONORED
lists               1 name:HONORED  search:IGNORED
folders             1 name:HONORED  search:IGNORED
```

So `groups.listAll({ slug })` returning **1 row** was not vendor filtering: the whole (1-row)
tenant came back. The decisive evidence is the search matrix, where a bogus value returns 0 rows:

```
node /tmp/probe-users.mjs
groups?search="9fd63e9f4ca2"   n=0     <-- search is honoured, and it does NOT match a slug
groups?search="Default"        n=1
groups?slug=9fd63e9f4ca2       n=1     <-- same as ?slug=zzz-nomatch, so the key is ignored
users?search="Soukhomlinov"    n=1
users?search="Max Soukhomlinov" n=0    <-- a full name is NOT matchable with `search`
users?search="0000000000"    n=0     <-- a slug is NOT matchable with `search`
users?slug=0000000000        n=1     (== users?slug=zzz-nomatch, ignored)
users?last_name=Soukhomlinov   n=1     <-- the field-specific filter the vendor DOES honour
```

`api-docs.json` agrees: `GET /groups` declares `name, default, search, page, page_size` (no `slug`);
`GET /users` declares `first_name, last_name, search, portal_member_company_id, archived, email,
security_level` (no `slug`, no `name`). The old code narrowed a **slug** stage with `search` and a
**full name** stage with `search` — in both cases a filter the record must fail, on a scan the
resolution contract advertises as COMPLETE. That is the false null.

### 3.3 FIX (source)

- `src/resources/groups.ts`: the slug stage no longer narrows with `search`. It walks the collection
  (`scanExact({}, …)`) and compares `slug` exactly; `ExactScan`/`decideScan` now carry the stage cost
  (`'client-scan'`). The `name` stage keeps the vendor-honoured `name` filter.
- `src/resources/users.ts`: the slug stage is an unfiltered client scan; the name stage first narrows
  with the documented `last_name` filter, and if that pass misses it falls back to a **complete**
  unfiltered client scan (a multi-word surname is not its last token, so the narrowed pass alone could
  hide a real user). `scanUnique` takes the cost so the reported `resolutionCost` is truthful.
- Caps are unchanged: a truncated scan still throws `RESOLUTION_TRUNCATED`, never `null`.

### 3.4 AFTER (live, rebuilt `dist`)

```
node /tmp/probe-after-defects.mjs
AFTER group slug: 9fd63e9f4ca2 | user slug: 0000000000 | user name: Max Soukhomlinov
  groups.resolve("<slug>")           OK {"id":1,"name":"Default Group","slug":"9fd63e9f4ca2",...}
  groups.resolve({slug})             OK {"id":1,...}
  groups.resolve("<name>")           OK {"id":1,...}
  users.resolve("<slug>")            OK {"id":1,"email":"user@example.com",...,"slug":"0000000000",...}
  users.resolve({slug})              OK {...}
  users.resolve("Max Soukhomlinov")  OK {...}
  users.resolve({name})              OK {...}
  users.resolve("<email>")           OK {...}
  users.resolve(<id>)                OK {...}
users.resolve slug details: {"cost":"client-scan","scanned":2,"trunc":false,"id":1}
groups.resolve slug details: {"cost":"client-scan","scanned":1,"trunc":false,"id":1}
```

`resolutionCost` now reports `client-scan` for the stages that really scan, so the wrapper cannot
claim a server filter that hid the record.

### 3.5 Every other resolve/findBy/search stage audited

Static audit of the filter key each stage sends, checked against `api-docs.json` **and** the live
matrix above:

| Resource | stage → filter sent | vendor doc | live honoured | verdict |
|---|---|---|---|---|
| groups | slug → *(was `search`)* now none (client scan) | no slug param | search does not match a slug | FIXED |
| users | slug → *(was `search`)* now none; name → *(was `search`)* now `last_name` + client scan | no slug/name param | search matches one field only | FIXED |
| users | email → `email` | yes | HONORED | ok |
| websites | slug → `slug`, name → `name` | yes | HONORED | ok |
| articles | slug → `slug`, name → `name`, search → `search` | yes | HONORED | ok |
| companies | slug → `slug`, name → `name`, website → `website`, search → `search` | yes | slug/name/search HONORED; `website` UNVERIFIED live | ok |
| asset_layouts | slug → `slug`, name → `name` | yes | HONORED | ok |
| folders | name → `name` | yes | HONORED | ok |
| lists | name → `name` | yes | HONORED | ok |
| password_folders | search → `search` | yes | UNVERIFIED (0 records) | ok (documented) |
| asset_passwords | slug → `slug`, search → `search` | yes | UNVERIFIED (0 records) | ok (documented) |
| vlan_zones | slug → none (already a client scan), name → `name` | no slug param | UNVERIFIED (0 records) | already correct |
| rack_storages | name → none (already a client scan) | no name param | UNVERIFIED (0 records) | already correct |
| networks | slug/name/address → same key | all three documented | UNVERIFIED (0 records) | ok (documented) |
| vlans | name → `name`, vlan_id → `vlan_id` | yes | UNVERIFIED (0 records) | ok (documented) |
| label_types | slug → `slug`, name → `name` | yes | UNVERIFIED (0 records) | ok (documented) |
| ip_addresses | address → `address`, fqdn → `fqdn` | yes | UNVERIFIED (0 records at the time) | ok (documented) |
| magic_dash | title → `title` | yes | UNVERIFIED (0 records) | ok (documented) |

No other stage was found to narrow with a filter the vendor **honours but the field fails** — the only
two such stages were groups-slug and users-slug/name, both fixed and both proven live. `?domain=` on
`/companies` is not a vendor param, but no code path sends it (`findByDomain` sends `website`).

## DEFECT 4 — advertised guards that can never run

Live harness used for both resources (create → inspect → guard → delete): `/tmp/probe-defect4b.mjs`
and `/tmp/probe-defect4-ip.mjs`.

### 4a `rack_storages.update` — DECISION: refuse, and say the true reason

BEFORE (live):

```
create response keys: ["id","name","description","descending_units","starting_unit","height","max_wattage","width","serial_number","asset_tag","front_items","rear_items","location_name","location_url","location_id","utilization","power_draw_utilization","power_utilization","company_id"]
created_at in response? false value: undefined
updated_at in response? false value: undefined
GET created_at/updated_at: undefined undefined
unguarded update: LIVE_OK
guarded update (wrong ts): REFUSED(CONFIG_ERROR) assertNotStale: the current rack_storages record for 6 carries no updated_at, so the expectedUpdatedAt guard cannot be verified for this resource.
```

The registry row said `staleCheck: "updated_at"` and listed `STALE_OBJECT`: a guard the vendor can
never satisfy, reached only through a wasted GET. The SDK therefore refuses (option **a**), and now
says why up front and truthfully:

```
AFTER  rack_storages.update guarded: REFUSED CONFIG_ERROR rack_storages.update cannot honour { expectedUpdatedAt }: the live vendor record carries no updated_at field, so there is no revision to compare. Omit the guard, or use { dryRun: true } to preview the change.
AFTER  rack_storages.update unguarded: LIVE_OK
```

Registry/source/type now agree: `staleCheck: "unavailable"`, `STALE_OBJECT` removed from the row's
`errors`, `RackStorage.created_at/updated_at/discarded_at` optional, and the derivation constant
`STALE_GUARD_RESOURCES` in `scripts/derive-plan.mjs` no longer contains `rack_storages` (that constant
is what re-derives `STALE_OBJECT` on every `plan:derive`, so editing the plan cell alone is reverted).

### 4b `ip_addresses.update` — DECISION: support the guard (the refusal's reason was false)

BEFORE (live):

```
create created_at/updated_at: "2026-09-13T03:05:11.914Z" "2026-09-13T03:05:11.914Z"
GET1 updated_at: "2026-09-13T03:05:11.914Z"
raw PUT status 200
GET2 updated_at= "2026-09-13T03:05:13.508Z" ADVANCED? true
SDK guarded update (wrong ts): REFUSED(CONFIG_ERROR) ip_addresses.update cannot honour { expectedUpdatedAt }: the vendor record declares no updated_at field...
```

So `expect...` was refused on a record whose `updated_at` exists and advances. The refusal is removed
and the shared `updateOne` guard runs (option **b**):

```
AFTER  ip updated_at on create: "2026-09-13T03:09:08.011Z"
AFTER  ip_addresses.update guarded WRONG ts: REFUSED STALE_OBJECT Stale object: ip_addresses 7 was not at the expected revision for ip_addresses.update (expected updated_at 2020-01-01T00:00:00.000Z, found 2026-09-13T03:09:08.011Z)
AFTER  ip_addresses.update guarded CURRENT ts: LIVE_OK
```

Registry: `staleCheck: "unavailable"` → `"updated_at"`, `STALE_OBJECT` added, `ip_addresses` added to
`STALE_GUARD_RESOURCES`, `metadata.usage` corrected. `IpAddress`/`IpAddressSummary` already declare the
timestamps and the vendor does send them, so no type change was needed. The delete path still refuses
(no conditional delete exists) and its comment now states that reason instead of the false one.

### 4c `procedure_tasks.update` (coordinator follow-up) — same class as 4a

```
task create keys: [... "subtask_count","has_subtasks"]   updated_at= undefined
task GET keys:    [... identical ...]                    updated_at= undefined
task unguarded update: LIVE_OK
task guarded update (wrong ts): REFUSED(CONFIG_ERROR) assertNotStale: the current procedure_tasks record for 6 carries no updated_at, ...
```

Same lie, same fix: explicit refusal with the true reason, `staleCheck` → `"unavailable"`,
`STALE_OBJECT` removed, `ProcedureTask.created_at/updated_at` optional (and the summary's `updated_at`
optional).

### 4d `magic_dash.updatePositions` — no defect found

Its registry row advertises **no** `STALE_OBJECT` and no `staleCheck` (it is a `specialOp` refused with
`POLICY_DENIED`), so nothing advertises a guard that cannot run. No live `magic_dash` record exists to
inspect the payload (UNVERIFIED), and no change was made.

## Files changed (no commit)

Source: `src/resources/groups.ts`, `users.ts`, `ip_addresses.ts`, `rack_storages.ts`,
`procedure_tasks.ts`. Types: `src/types/rack_storage.ts`, `src/types/procedure_task.ts`.
Registry: `capabilities.plan.json` (cells + test rows), then re-derived
`capabilities.json`, `src/capabilities.ts`, `capabilities.schema.json`, `MCP_TOOL_MANIFEST.md`;
`scripts/derive-plan.mjs` (`STALE_GUARD_RESOURCES`). Tests:
`test/resources/{groups,users,ip_addresses,rack_storages,procedure_tasks}.test.ts`.

## GATES (all run after the final edit, on the rebuilt tree)

```
npx tsc --noEmit                                  -> no output (clean)
npm run lint                                      -> eslint src test (clean, no findings)
npx vitest run                                    -> Test Files 50 passed (50); Tests 1631 passed (1631)
node scripts/check-capabilities.mjs               -> PASS - 0 failures; rows=225 scoped=225 registryRecords=225 warnings=66
node scripts/project-mcp-tools.mjs --check-example-> PASS: every projected example is a call the SDK accepts and no schema advertises an operation-invalid field
npm run plan:derive && npm run capabilities:build && npm run mcp:project   -> ran (141 rows re-derived, judgement columns preserved)
```

`check-capabilities.mjs` first failed with `manifest-planhash` (manifest pinned the old plan hash)
because a plan edit always invalidates it; `npm run mcp:project` refreshed it and the check then passed.

Tests: 1627 → 1631 (net +4). Tests **replaced** rather than deleted, because the old bodies encoded the
false behaviour: `rack_storages.update` "maps a mismatch to STALE_OBJECT" (the fixture handed the mock a
record the vendor never sends) → "refuses expectedUpdatedAt on update with CONFIG_ERROR and issues no
request"; `procedure_tasks.update` same; `ip_addresses.update` "refuses … with CONFIG_ERROR" → the two
guard tests that now prove `STALE_OBJECT` and `LIVE_OK`. New tests: groups slug client-scan regression,
users slug client-scan regression, users `last_name` narrowing + complete-scan fallback, rack_storages
optional-timestamp fixture, ip_addresses guard match. No test was skipped or weakened.

## Contract-surface notes (flagged, not done silently)

1. `metadata.usage` prose for `groups.resolve`, `users.resolve`, `ip_addresses.update` was corrected
   (MCP tool descriptions change textually). Factual correction only; the `resolution.basis` value was
   left at `server-filter` because the registry vocabulary has no "mixed" value and both helpers do
   still use real server filters. If the coordinator wants `client-scan` recorded for those rows, that
   is a one-word plan edit — I did not make it because it would overstate the email/name stages.
2. `RackStorageSummary.updated_at` and `ProcedureTaskSummary.updated_at` became optional, so the
   projected MCP tool schemas mark those fields non-required. Removing the fields entirely would shrink
   the published summary shape, so I kept them and only told the truth about presence.
3. Tenant data: nothing pre-existing was touched or deleted.

## 4. FINAL INVENTORY (tenant back to baseline)

```
node /tmp/probe-after-defects.mjs   (last line; activity_logs counted with a full listAll sweep)
{"companies":21,"articles":4,"asset_layouts":4,"websites":2,"groups":1,"users":1,"lists":1,"folders":1,"networks":1,"rack_storages":0,"ip_addresses":0,"procedures":0,"relations":0,"vlans":0,"vlan_zones":0,"label_types":0,"activity_logs":466}
node -e "… activityLogs.listAll() …"   -> activity_logs 466
```

Baseline (21/4/4/2/1/1/1/1/1/466) is reproduced exactly. Records created during the probes
(rack_storages 6, procedure_tasks 6, procedures 9/10, ip_addresses 6/7, networks 7) were each deleted
and the deletes are in the transcripts (`delete … OK`).

## UNVERIFIED

- `networks`, `vlans`, `vlan_zones`, `rack_storages` (name stage), `label_types`, `asset_passwords`,
  `password_folders`, `magic_dash`, `ip_addresses` (address/fqdn), `asset_layouts` on an empty tenant:
  the tenant held 0 of these records, so their stage filters are taken from `api-docs.json` only.
- `companies.findByDomain` sends `website`, a documented param that was never exercised against a live
  company with a website (the `slug`/`name`/`search` params on the same endpoint ARE live-HONORED).
- `procedure_tasks.update`'s refusal was verified live BEFORE and by unit test AFTER; the live AFTER
  re-check was not run (the rack_storages/ip_addresses AFTER runs cover the same code shape).
- `magic_dash.updatePositions` carries no guard advertisement and no live record exists to inspect.
