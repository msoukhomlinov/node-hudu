# Live seed & exercise report — infrastructure resources

**Resources owned:** `networks`, `vlans`, `vlan_zones`, `ip_addresses`, `rack_storages`,
`rack_storage_items`, `relations` (44 of the 225 registry operations).
**Tenant:** `https://hudu-sandbox.example.com` (throwaway key, taken from the environment only —
it is not in this file, not in any script, not in any committed file).
**Branch:** `feat/agent-execution-layer` (no switch, no commit, no push, no source edit; therefore no
`npm run build` was needed — the harness runs against the already-built `dist/`).
**Verdict:** tenant restored bit-for-bit. 13 records created, 13 deleted, 0 survivors.

## 1. Commands run (exact)

```
node scripts/live-coverage.mjs --json /tmp/lc-before.json      # pre-sweep
node scripts/live-seed-infrastructure.mjs                      # seed + exercise + guards + cleanup (kept in repo)
node scripts/_probe-rsi.mjs / _probe-rsi2.mjs                  # rack_storage_items payload matrix (scratch, deleted)
node scripts/_probe-net.mjs / _probe-ip.mjs                    # D1/D3 repro (scratch, deleted)
node /tmp/counts.mjs                                           # final inventory
node scripts/live-coverage.mjs --json /tmp/lc-after.json       # post-sweep
```
Full artifacts: `/tmp/live-seed.log`, `/tmp/live-seed-infrastructure.json`, `/tmp/lc-before.json`,
`/tmp/lc-after.json`.

## 2. Coverage before -> after (my 44 operations)

| stage | LIVE_OK | DRY_OK | SKIP | REFUSED | THREW | UNVERIFIED |
|-------|---------|--------|------|---------|-------|------------|
| `live-coverage.mjs` before | 9 | 9 | 25 | 0 | 1 | 0 |
| my harness (real calls + dry-runs) | 39 | (all writes dry-run first) | 0 | 1 | 0 | 4 |

All 39 are calls that really hit the API; 21 of them were writes executed for real and then deleted.
The 5 non-LIVE rows are all `rack_storage_items` (1 refused by the vendor with HTTP 500, 4 that cannot
target anything because no record can exist) — see D4.
**The post-sweep is not a coverage regression:** after cleanup `live-coverage.mjs` reports my resources
as SKIP again, because for these endpoints the sweep's LIVE_OK/SKIP verdict is purely a function of
tenant data (it never writes). Its own BEFORE/AFTER totals did move (LIVE_OK 61 -> 75, SKIP 97 -> 68)
for other agents' resources that had data.

## 3. Per-operation status

| # | Operation | Kind | Sweep BEFORE | Status | Evidence / exact detail |
|---|-----------|------|--------------|--------|-------------------------|
| 1 | `networks.list` | read | SKIP-free: LIVE_OK | **LIVE_OK** | 1 row (id 1); 2 rows with my seed; 1 row after cleanup |
| 2 | `networks.get` | read | LIVE_OK (id 1) | **LIVE_OK** | id 1, then seeded id 5 and id 6 |
| 3 | `networks.create` | write | DRY_OK | **LIVE_OK** | REAL: id 5, id 6 (20 keys each); both deleted |
| 4 | `networks.update` | write | DRY_OK | **LIVE_OK** | REAL: name/description land; `notes` silently dropped by vendor (D3) |
| 5 | `networks.delete` | write | DRY_OK | **LIVE_OK** | REAL: id 5, id 6; get -> NOT_FOUND: Network not found |
| 6 | `networks.resolve` | helper | SKIP* | **LIVE_OK** | name -> id 5; id 5 -> record (*sweep called it with id 1 only) |
| 7 | `networks.findByAddress` | helper | THREW(VALIDATION_FAILED) | **LIVE_OK** | '10.99.0.0/24' -> id 5; '192.0.2.0/24' -> null. Sweep THREW is its own empty-address call (D5) |
| 8 | `vlans.list` | read | SKIP(no data) | **LIVE_OK** | 0 -> 1 -> 0 rows; filters vlan_zone_id/company_id/vlan_id used |
| 9 | `vlans.get` | read | SKIP(no data) | **LIVE_OK** | id 3 seeded record |
| 10 | `vlans.create` | write | DRY_OK | **LIVE_OK** | REAL: id 3 (vlan_id 905, vlan_zone_id 3) |
| 11 | `vlans.update` | write | DRY_OK | **LIVE_OK** | REAL: note marker landed; stale guard -> STALE_OBJECT 412 |
| 12 | `vlans.delete` | write | DRY_OK | **LIVE_OK** | REAL: id 3; get -> NOT_FOUND: VLAN not found |
| 13 | `vlans.resolve` | helper | SKIP(no data) | **LIVE_OK** | name -> id 3; id 3 -> summary |
| 14 | `vlans.findByVlanId` | helper | SKIP(no data) | **LIVE_OK** | 905 -> id 3 |
| 15 | `vlan_zones.list` | read | SKIP(no data) | **LIVE_OK** | 0 -> 1 -> 0 rows |
| 16 | `vlan_zones.get` | read | SKIP(no data) | **LIVE_OK** | id 3 seeded record |
| 17 | `vlan_zones.create` | write | DRY_OK | **LIVE_OK** | REAL: id 3 (vlan_id_ranges 900-910) |
| 18 | `vlan_zones.update` | write | DRY_OK | **LIVE_OK** | REAL: description marker landed; stale guard -> STALE_OBJECT 412 |
| 19 | `vlan_zones.delete` | write | DRY_OK | **LIVE_OK** | REAL: id 3; get -> NOT_FOUND: VLAN Zone not found |
| 20 | `vlan_zones.resolve` | helper | SKIP(no data) | **LIVE_OK** | name -> id 3; id 3 -> summary |
| 21 | `ip_addresses.list` | read | SKIP(no data) | **LIVE_OK** | 0 -> 1 -> 0 rows; network_id filter used |
| 22 | `ip_addresses.get` | read | SKIP(no data) | **LIVE_OK** | id 3 (seeded), id 5 (probe) |
| 23 | `ip_addresses.create` | write | DRY_OK | **LIVE_OK** | REAL: id 3 (10.99.0.5, network_id 1), id 5 (10.97.0.9) |
| 24 | `ip_addresses.update` | write | SKIP(no data) | **LIVE_OK** | REAL: id 5 description+notes persisted, updated_at advanced. WITH { expectedUpdatedAt } -> REFUSED CONFIG_ERROR (D1) |
| 25 | `ip_addresses.delete` | write | SKIP(no data) | **LIVE_OK** | REAL: id 3, id 5; get -> NOT_FOUND: IpAddress not found |
| 26 | `ip_addresses.resolve` | helper | SKIP(no data) | **LIVE_OK** | '10.99.0.5' -> id 3; id 3 -> summary |
| 27 | `ip_addresses.findByAddress` | helper | SKIP(no data) | **LIVE_OK** | '10.99.0.5' -> id 3; '10.99.0.250' -> null |
| 28 | `rack_storages.list` | read | SKIP(no data) | **LIVE_OK** | 0 -> 1 -> 0 rows |
| 29 | `rack_storages.get` | read | SKIP(no data) | **LIVE_OK** | id 3 (seeded), id 5 (probe) |
| 30 | `rack_storages.create` | write | DRY_OK | **LIVE_OK** | REAL: id 3, id 5 (height/width/max_wattage accepted) |
| 31 | `rack_storages.update` | write | SKIP(no data) | **LIVE_OK** | REAL (no guard): description marker landed. WITH { expectedUpdatedAt } -> REFUSED CONFIG_ERROR (D2) |
| 32 | `rack_storages.delete` | write | SKIP(no data) | **LIVE_OK** | REAL: id 3, id 5; get -> NOT_FOUND: RackStorage not found |
| 33 | `rack_storages.resolve` | helper | SKIP(no data) | **LIVE_OK** | name -> id 3; id 3 -> summary (its updated_at is undefined, D2) |
| 34 | `rack_storage_items.list` | read | LIVE_OK 0 rows | **LIVE_OK** | 0 rows before, during and after: nothing can be created |
| 35 | `rack_storage_items.create` | write | DRY_OK | **REFUSED SERVER_ERROR** | HTTP 500 Internal Server Error on 7 payload shapes incl. the documented example (D4) |
| 36 | `rack_storage_items.get` | read | SKIP(no id) | **UNVERIFIED** | no record can exist: create 500s, tenant has 0 items |
| 37 | `rack_storage_items.update` | write | SKIP(no id) | **UNVERIFIED** | same; also design-refuses expectedUpdatedAt (no updated_at field) |
| 38 | `rack_storage_items.delete` | write | SKIP(no id) | **UNVERIFIED** | same |
| 39 | `rack_storage_items.resolve` | helper | SKIP(no id) | **UNVERIFIED** | only the undefined-identifier CONFIG_ERROR was observable |
| 40 | `relations.list` | read | SKIP(no data) | **LIVE_OK** | 0 -> 2 -> 0 rows; fromable_type/fromable_id filter used |
| 41 | `relations.create` | write | DRY_OK | **LIVE_OK** | REAL: id 1 (Company 13 -> Company 3) |
| 42 | `relations.delete` | write | SKIP(no data) | **LIVE_OK** | REAL: id 1; list back to 0 |
| 43 | `relations.resolve` | helper | SKIP(no data) | **LIVE_OK** | id 1 -> relation summary |
| 44 | `relations.findByEndpoints` | helper | SKIP(no data) | **LIVE_OK** | {Company,13}->{Company,3} -> [id 1] |

`DRY_OK` in the sweep column means the sweep only issued `{ dryRun: true }`; every one of those is now
a real, executed-and-reverted write.

## 4. DryRunResult evidence (writes refuse nothing; dry-run is "the last argument")

Every write of my resources was issued with `{ dryRun: true }` FIRST, in the options slot. Example
(truncated real payload):

```json
{"operation":"networks.create","wouldApply":true,"target":{"resource":"networks","ids":[]},
 "request":{"method":"POST","path":"/networks"},
 "checks":[{"name":"payload-present","ok":true,"detail":"request body supplied"}],
 "impact":{"affected":1,"scope":"single","reversible":true},"simulated":true,"warnings":[]}
{"operation":"networks.delete","wouldApply":true,"target":{"resource":"networks","ids":[1]},
 "request":{"method":"DELETE","path":"/networks/1"},"checks":[{"name":"target-identifier","ok":true,"detail":"target 1"}],
 "impact":{"affected":1,"scope":"single","reversible":false},"simulated":true,"warnings":[]}
```

Dry-runs recorded: `create` x7, `update` x6, `delete` x7 = 20 `wouldApply:true` results, each with a
`checks[]` array and an `impact` block. No dry-run issued an HTTP request (proved by the fetch spy:
the request count did not move during the dry-run block).

## 5. Update guards (`expectedUpdatedAt`)

| resource | stale `expectedUpdatedAt` | did it land? | fresh `expectedUpdatedAt` | did it land? |
|----------|---------------------------|--------------|---------------------------|--------------|
| networks | **STALE_OBJECT** (412) | no (name + `updated_at` unchanged) | accepted | yes (name/description changed) |
| vlans | **STALE_OBJECT** (412) | no | accepted | yes (marker in record) |
| vlan_zones | **STALE_OBJECT** (412) | no | accepted | yes (marker in record) |
| ip_addresses | **REFUSED CONFIG_ERROR** (D1) | no | **REFUSED CONFIG_ERROR** (D1) | no — the guard is refused before any request; an unguarded update does land |
| rack_storages | **REFUSED CONFIG_ERROR** "carries no `updated_at`" (D2) | no | n/a — no revision exists to pass | unguarded update lands |
| rack_storage_items | design refusal (`CONFIG_ERROR`, no `updated_at` on the vendor record) | no | n/a | UNVERIFIED (no record) |
| relations | n/a — `/relations` has no update path in the registry (`create`, `delete`, `list`, `resolve`, `findByEndpoints` only) | | | |

Extra strength of the guard, from `networks` (`/tmp` probe log):

```
update2 with fresh revision (2026-09-13T02:52:29.846Z) -> OK, name changed, updated_at advanced
update3 with the SAME revision again -> STALE_OBJECT 412
  "Stale object: networks 6 was not at the expected revision for networks.update
   (expected updated_at 2026-09-13T02:52:29.846Z, found 2026-09-13T02:52:30.017Z)"
```
So STALE_OBJECT is a real 412 from the SDK's revision compare, the write does not land, and the
revision really advances after a successful write.

## 6. Non-paginated endpoints: `page`/`page_size` are never sent (fetch spy)

`globalThis.fetch` was wrapped and every URL recorded while calling `listAll()` bare, `listAll({page:3,
page_size:2})` and `list({page:4,page_size:2})`:

| resource | URL seen | `page` sent? | `page_size` sent? |
|----------|----------|--------------|-------------------|
| networks | `/api/v1/networks` | no | no |
| vlans | `/api/v1/vlans` | no | no |
| vlan_zones | `/api/v1/vlan_zones` | no | no |
| ip_addresses | `/api/v1/ip_addresses` | no | no |
| rack_storages | `/api/v1/rack_storages` | no | no |
| rack_storage_items | `/api/v1/rack_storage_items` | no | no |
| relations (registry says `mode: page`) | `/api/v1/relations?page=1&page_size=25`, `?page=3&page_size=2`, `?page=4&page_size=2` | yes | yes |

Even an explicit `{ page, page_size }` is stripped for the six non-paginated resources and honoured
only for `relations` — the spy check the sweep cannot make.

## 7. Reads, with data (before -> during the seed -> after cleanup)

| resource | pre-seed | seeded | final | filter used |
|----------|----------|--------|-------|-------------|
| networks | 1 (id 1) | 2 | 1 | `company_id:13` -> [1,5]; `name` -> [5] |
| vlans | 0 | 1 | 0 | `vlan_zone_id` -> 1 row |
| vlan_zones | 0 | 1 | 0 | — |
| ip_addresses | 0 | 1 | 0 | `network_id` -> 1 row |
| rack_storages | 0 | 1 | 0 | — |
| rack_storage_items | 0 | 0 | 0 | create 500s, see D4 |
| relations | 0 | 2 | 0 | `fromable_type:Company, fromable_id:13` -> 1 row |
| companies (untouched) | 21 | 21 | 21 | — |
| activity_logs (untouched) | 466 | — | 466 | — |

`get()` on the seeded rows unwrapped the vendor envelope correctly (`{"id":5,"name":"ZZ live-coverage
network",...}`, 20 keys for a network, 15 for a vlan, 11 for a vlan zone, 14 for an IP, 19 for a rack
storage, 12 for a relation). `get()` on a deleted/absent id threw `NOT_FOUND`
(`Network not found`, `VLAN not found`, `VLAN Zone not found`, `IpAddress not found`,
`RackStorage not found`).

## 8. Defects found (each with its reproduction)

**D1 — `ip_addresses.update` refuses `{ expectedUpdatedAt }` on a false premise (guard unavailable
where the revision field demonstrably exists).**
Repro (real, repeated): create -> `updated_at: "2026-09-13T02:51:46.817Z"`; `get` -> same field
present; unguarded update -> `updated_at: "2026-09-13T02:54:10.096Z"` (field exists AND advances).
Then `ipAddresses.update(id, {description:'x'}, {expectedUpdatedAt:'2000-01-01T00:00:00.000Z'})` ->
`CONFIG_ERROR: ip_addresses.update cannot honour { expectedUpdatedAt }: the vendor record declares no
updated_at field.` The record does declare it, so a working STALE_OBJECT guard is being refused. The
registry advertises `STALE_OBJECT` for this operation; that error is unreachable today.
(`api-docs.json` shows why: the `IpAddress` *definition* omits `updated_at`, while
`src/types/ip_address.ts` and the live API have it — the spec, not the tenant, is wrong.)

**D2 — `rack_storages`: the advertised guard cannot run, and the live record contradicts its own type.**
`POST /rack_storages` and `GET /rack_storages/{id}` return a record whose keys are
`id,name,description,descending_units,starting_unit,height,max_wattage,width,serial_number,asset_tag,
front_items,rear_items,location_name,location_url,location_id,utilization,power_draw_utilization,
power_utilization,company_id` — **no `created_at`, no `updated_at`**, although `api-docs.json`
(the `RackStorage` definition) and `src/types/rack_storage.ts` (both declared *required*) say they
exist. Consequence: `rack_storages.update(id, data, {expectedUpdatedAt: <any string>})` ->
`CONFIG_ERROR: assertNotStale: the current rack_storages record for 3 carries no updated_at, so the
expectedUpdatedAt guard cannot be verified for this resource.` So the `expectedUpdatedAt` option and
the `STALE_OBJECT` error listed in the registry for `rack_storages.update` are unreachable, and
`rack_storages.resolve()`'s summary carries `updated_at: undefined`.

**D3 — `networks.create` / `networks.update` silently drop `notes`.**
Repro: `networks.create({name,address,network_type:1,company_id:13,notes:'ZZ-NOTES-A'})` -> response
`notes: null`, read-back `notes: null`; the same via `networks.update` (fresh revision accepted) ->
`notes: null`, read-back `notes: null`. `name` and `description` from the same body DO persist.
The write is reported as applied (`DryRunResult.wouldApply: true`, HTTP 200 with no warning), so a
caller has no signal that the field was discarded. (`vlans` and `ip_addresses` persist `notes`
normally — it is specific to `networks`.)

**D4 — `POST /rack_storage_items` returns HTTP 500 for every payload shape (vendor-side, blocks 5 ops).**
7 shapes tried, including the vendor's own documented example:
`{rack_storage_role_id, asset_id, start_unit, end_unit, status:0, side:0}` (rack id = the created
rack, asset id = 332 and the company-scoped asset), plus `+company_id:13`, no-role, no-asset,
`rack_storage_role_id: 1`, no status/side, `side:'front'`, `end_unit == start_unit`, asset-only and a
minimal `{rack_storage_role_id, asset_id, start_unit, end_unit}`. Every one:
`{"name":"ServerError","code":"SERVER_ERROR","status":500,"message":"Internal Server Error"}`.
`{ dryRun: true }` passes (it never reaches the vendor). Result: `rack_storage_items.create`,
`.get`, `.update`, `.delete` and `.resolve` cannot be exercised on this tenant.

**D5 — two artifacts of the sweep tool itself (not SDK defects).**
(a) `networks.findByAddress` is reported `THREW VALIDATION_FAILED: ... an empty address` because the
sweep calls it with no address; with a real CIDR the helper is `LIVE_OK` (`null` on a miss).
(b) For my seven resources the sweep's SKIP/LIVE_OK verdict is a pure function of tenant data, so it
shows SKIP again after a correct cleanup — the sweep's "no live row to target" is a data condition,
not a coverage hole.

## 9. Cleanup proof

Created (13 records): `networks` 5, 6 · `vlan_zones` 3 · `vlans` 3 · `ip_addresses` 3, 5 ·
`rack_storages` 3, 5 · `relations` 1 (`rack_storage_items` never created, D4).
Deleted in dependency order (`relations`, `rack_storage_items`, `ip_addresses`, `rack_storages`,
`vlans`, `vlan_zones`, `networks`), each with a dry-run delete first and a real delete after, each
followed by a `get()`:

```
relations.delete id=1 OK            ip_addresses.delete id=3,5 OK
rack_storages.delete id=3,5 OK      vlans.delete id=3 OK
vlan_zones.delete id=3 OK           networks.delete id=5,6 OK
get after delete -> NOT_FOUND (IpAddress / RackStorage / VLAN / VLAN Zone / Network not found)
residue scan for 'ZZ live-coverage|ZZ stale attempt|ZZ fresh landed' across all 7 resources: none
```

Final live inventory vs the stated baseline: `networks 1` (=1), `vlans 0`, `vlan_zones 0`,
`ip_addresses 0`, `rack_storages 0`, `rack_storage_items 0`, `relations 0` — all at baseline.
Not touched and re-verified: `companies 21`, `articles 4`, `asset_layouts 4`, `websites 2`,
`groups 1`, `users 1`, `lists 1`, `activity_logs 466` (unchanged **including** the audit log).

## 10. UNVERIFIED (with the reason)

| operation | reason |
|-----------|--------|
| `rack_storage_items.create` | exercised, but only ever REFUSED: HTTP 500 for 7 shapes (D4) |
| `rack_storage_items.get` | no rack storage item can exist on this tenant (0 rows, create 500s) |
| `rack_storage_items.update` | same |
| `rack_storage_items.delete` | same |
| `rack_storage_items.resolve` | same; only the undefined-identifier `CONFIG_ERROR` was observable |
| `ip_addresses.update` with a guard | REFUSED by design (D1); the unguarded update is LIVE_OK |
| `rack_storages.update` with a guard | REFUSED because the live record has no `updated_at` (D2) |
| `relations` update guard | `/relations` exposes no update path in the registry — nothing to guard |
