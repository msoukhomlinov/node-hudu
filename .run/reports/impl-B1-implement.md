# impl-B1 — Group B (networks, vlans, vlan_zones, ip_addresses, rack_storages)

Branch `feat/agent-execution-layer`. Scope: my 33 plan rows (25 primitive + 8 helper) for
`networks`, `vlans`, `vlan_zones`, `ip_addresses`, `rack_storages`.

## Files changed

| path | lines | what |
|---|---|---|
| src/resources/networks.ts | 316 | `resolve`, `findByAddress`, dry-run + stale overloads on create/update/delete |
| src/resources/vlans.ts | 315 | `resolve` (id -> vlan_id -> name, with a bare-number fallback), `findByVlanId`, dry-run + stale overloads |
| src/resources/vlan_zones.ts | 292 | `resolve` (id -> slug -> name), dry-run + stale overloads |
| src/resources/ip_addresses.ts | 309 | `resolve`, `findByAddress`, dry-run overloads (staleCheck unavailable) |
| src/resources/rack_storages.ts | 281 | `resolve` (id direct, name = bounded client scan), dry-run + stale overloads |
| src/types/network.ts | 68 | `NetworkSummary`, `NetworkIdentifier` |
| src/types/vlan.ts | 60 | `VlanSummary`, `VlanIdentifier` |
| src/types/vlan_zone.ts | 53 | `VlanZoneSummary`, `VlanZoneIdentifier` |
| src/types/ip_address.ts | 56 | additive `id?: number` on `IpAddress`, `IpAddressSummary`, `IpAddressIdentifier` |
| src/types/rack_storage.ts | 54 | `RackStorageSummary`, `RackStorageIdentifier` |
| test/resources/networks.test.ts | 443 | 35 tests |
| test/resources/vlans.test.ts | 376 | 33 tests |
| test/resources/vlan_zones.test.ts | 334 | 30 tests |
| test/resources/ip_addresses.test.ts | 359 | 33 tests |
| test/resources/rack_storages.test.ts | 350 | 31 tests |

Additive only: no existing primitive signature, return type or behaviour changed;
`git diff --stat` for my 10 src files = 1431 insertions / 30 deletions (the deletions are the old
one-line method bodies replaced by overload sets).

## Commands run (with exit codes)

| command | exit | result |
|---|---|---|
| `npx tsc --noEmit` | 0 | project-wide green (no error in any file) |
| `npx eslint <my 5 resources> <my 5 type files> <my 5 test files>` | 0 | clean |
| `npx vitest run test/resources/networks.test.ts test/resources/vlans.test.ts test/resources/vlan_zones.test.ts test/resources/ip_addresses.test.ts test/resources/rack_storages.test.ts` | 0 | 5 files, 162 tests passed |
| the same 5 files with `--coverage --coverage.include='src/resources/{networks,vlans,vlan_zones,ip_addresses,rack_storages}.ts'` | 0 | my files: 99.78 % stmts / 96.06 % branch / 100 % funcs / 100 % lines |

NOT run (forbidden for implementers): `npm run capabilities:build`, `npm run capabilities:check`,
`node scripts/*.mjs`, `npm run build`, `npm pack`, bare `vitest run` / `npm test`.

## Plan test titles

All 101 distinct required titles for my 33 rows are present, verbatim, in the named files (0 missing).
Verified mechanically with the same regex `scripts/check-capabilities.mjs` uses.
Duplicate titles across rows in one file are satisfied by one `it()` (e.g. "surfaces a correlation id
on the success path and the error path", "sends the expectedUpdatedAt guard and maps a mismatch to
STALE_OBJECT", "returns null after a complete scan", "returns NetworkSummary").

Helper rows implemented (8/8): `networks.resolve`, `networks.findByAddress`, `vlans.resolve`,
`vlans.findByVlanId`, `vlan_zones.resolve`, `ip_addresses.resolve`, `ip_addresses.findByAddress`,
`rack_storages.resolve` — public methods with exactly those names.

Contract evidence per helper: unique match; complete-scan null; `{ id }` miss -> NOT_FOUND (never
null); cap -> RESOLUTION_TRUNCATED; several exact matches -> RESOLUTION_AMBIGUOUS with candidate ids
in `resourceIds`; compact by default, `{ expand: true }` -> full record, `{ resolutionDetails: true }`
-> `Resolution<T>`; exactly one HTTP request per scan and `page`/`page_size` never on the wire;
unsupported identifier kind -> `ValidationFailedError` naming the accepted kinds.

Compact shapes (declared in the resource's own type file; drops the generator will derive):
`NetworkSummary` keeps the doc fields, drops description, notes, ancestry, settings, sync_identifier, is_radar, created_at, archived_at ; `VlanSummary` keeps the doc fields, drops description, notes, archived_at, created_at ; `VlanZoneSummary` keeps the doc fields, drops description, archived_at, created_at ; `IpAddressSummary` keeps the doc fields, drops notes, skip_dns_validation (+ id, because IpAddress gained the additive optional id) ; `RackStorageSummary` keeps the doc fields, drops description, created_at, discarded_at

## Gaps / for the coordinator

1. UNVERIFIED (blocking the group-B gate): all 8 of my helper rows are still `status: "planned"` in
   `capabilities.plan.json` (coordinator-owned; I did not touch it). The gate fails `batch-status`
   until they are flipped to `implemented`/`tested`, and `coverage-registry` needs a
   `capabilities:build` run to emit their records.
2. UNVERIFIED: `npm run capabilities:check -- --group B` and `capabilities:build` were not run
   (forbidden). The emission derives `outputSchema.drops` from my interfaces (list above); the
   additive `IpAddress.id` means the ip_addresses helper drops will read
   `[id, notes, skip_dns_validation]` rather than the design doc's `[notes, skip_dns_validation]`.
   Add `id` to `IpAddressSummary` if the doc-exact list is preferred — say so and I will change it.
3. UNVERIFIED: project-wide `npm test` coverage (I ran only my own files, as instructed).
4. Plan/reality mismatch to decide: `networks.create`, `vlans.create`, `vlan_zones.create` and
   `rack_storages.create` declare `staleCheck: "updated_at"`, but a create has no existing record to
   compare against, so it accepts `{ expectedUpdatedAt }` and cannot honour it. Their declared test
   title "sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT" is implemented and
   passing on the UPDATE and DELETE paths, where the guard is real. Only `updateOne` carries the
   guard in `base.ts`, so `delete()` calls `assertNotStale` itself before the DELETE.
   Suggest `staleCheck: "unavailable"` on the create rows.
5. `vlan_zones.resolve` slug kind: Hudu exposes no `slug` filter on `/vlan_zones`, so the slug step is
   ONE complete read of the non-paginated collection, reported honestly as
   `resolutionCost: "client-scan"`; the name step uses the vendor `name` filter. `vlans` has no slug
   filter either, so `{ slug }` is rejected with the structured validation error naming
   `id, vlan_id, exact name`.
6. Truncation semantics (all 5 resources are non-paginated): the record cap is enforced by trimming
   the fetched page and reporting `hasMore`, so a collection larger than the cap throws
   `RESOLUTION_TRUNCATED` instead of claiming completeness. A match found inside a truncated scan is
   refused, not returned (asserted by a test).
7. `list` and `listPages` are public methods with no plan row -> `unplanned-surface` WARNINGS
   (pre-existing, repo-wide). No behaviour changed there.
8. Compact summaries/identifiers are imported directly from `src/types/<resource>.js`; per the
   coordinator steer `src/types/index.ts` was NOT touched (coordinator adds the barrel exports at the
   batch gate).


---

## Revision 2 — coordinator rulings applied (2026-09-13)

**1. staleCheck `updated_at` is update-only.** Removed the read-then-compare guard from
`networks.delete`, `vlans.delete`, `vlan_zones.delete`, `rack_storages.delete` (each now just calls
`deleteOne`, with a comment naming the registry value `unavailable`). The four `<res>.update` paths
keep the guard through `base.updateOne` + `{ expectedUpdatedAt }`. The four delete-guard tests were
replaced by tests that assert a delete issues exactly ONE request and that request is the DELETE
(no read). `ip_addresses.update` now accepts `{ expectedUpdatedAt }` but does NOT forward it
(staleCheck `unavailable`, the record declares no `updated_at`), so no fabricated STALE_OBJECT is
possible; asserted by a new test. `src/resources/ip_addresses.ts` and the 4 resource files changed;
`assertNotStale` no longer appears in any B1 file.

**2. `IpAddressSummary` keeps `id`.** Added `id?: number` to `IpAddressSummary` and
`id: record.id` to the projector (optional because the vendor definition does not guarantee it), so
the derived drops are exactly `[notes, skip_dns_validation]`. The ip_addresses test's exact-drop
assertion (`Object.keys(summary)` equality + `not.toHaveProperty` for each dropped field) now expects
`id` in the kept set.

**3. vlan_zones `{slug}`** — unchanged (one complete collection read, reported `client-scan`).

**4. Rows stay `planned`** until the coordinator's group-B gate; nothing in my files blocks the flip.
Verified against the UPDATED plan: all required titles for my 33 rows still exist verbatim (0
missing), and the plan's per-row `staleCheck` now matches the implementation
(`update` → `updated_at` for networks/vlans/vlan_zones/rack_storages, `unavailable` for
ip_addresses.update and every create/delete row).

### Recorded exit codes (revision 2)

| command | exit | result |
|---|---|---|
| `npx eslint <my 10 src + 5 test files>` | 0 | clean |
| `npx vitest run <my 5 test files>` | 0 | 5 files, **163 tests passed** |
| `npx tsc --noEmit` | 0 | project-wide green |
| 5 test files + `--coverage --coverage.include='src/resources/{networks,vlans,vlan_zones,ip_addresses,rack_storages}.ts'` | 0 | 99.77 % stmts / 95.9 % branch / 100 % funcs / 100 % lines |

Test counts now: networks 35, vlans 33, vlan_zones 30, ip_addresses 34, rack_storages 31 = 163.
Line counts now: src/resources 311/312/289/314/278, src/types 68/60/53/59/54,
test/resources 442/376/334/371/350.
