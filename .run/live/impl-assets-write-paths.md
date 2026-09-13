# Live verification: `assets` write paths (defects 1 and 2)

Tenant: Hudu 2.45.1 @ `https://hudu-sandbox.example.com` (throwaway key, process env only - the key is in
no file in this repo). Repo `node-hudu`, branch `feat/agent-execution-layer` (not switched, nothing committed
or pushed). Every probe asset was created by this session and deleted before the final inventory; no
pre-existing record was modified (see the company-13 disclosure in section 7).

## 1. Defects, the change, and the status

| # | Sev | Path | Defect (live-observed) | Change | Status |
|---|-----|------|------------------------|--------|--------|
| 1 | HIGH | `assets.update`, `assets.moveLayout`, `assets.archive`, `assets.unarchive` | `expectedUpdatedAt` is silently dropped: NO error, NO guard, and the stale write LANDS | `refuseExpectedUpdatedAtOutsideUpdate(operation, opts)` inserted before `requireCompanyId` on each path | FIXED and proven live |
| 1b | HIGH | `assets.create`, `assets.delete` | same silent-drop defect, same hand-rolled cast (`AssetWriteOptions`) | same refusal (superset of the four named paths - see section 7) | FIXED and proven live |
| 2 | MEDIUM | `assets.create`, `assets.update`, `assets.moveLayout` | the vendor body is a one-key envelope `{ asset: {...} }`; the SDK returned it typed as the record, so `res.id === undefined` and a seeder leaked 3 probes | `unwrapCreated` (create), `unwrapSingle` (update, moveLayout) | FIXED and proven live |

Files changed (source): `src/resources/assets.ts` only. Tests changed:
`test/resources/assets.test.ts`. No other module, no registry row, no published contract.

## 2. BEFORE - reproduced live on the pre-fix `dist`

Command:

```
npm run build && HUDU_BASE_URL=https://hudu-sandbox.example.com HUDU_API_KEY=*** \
  node /tmp/asset_probe.mjs           # probe script kept OUTSIDE the repo (/tmp), key from env only
```

Observed (verbatim, company 13, probe asset created and deleted by the probe):

```
PROBE layoutId :: 1
PROBE accountAssetsBefore :: 20
PROBE company13AssetsBefore :: 0
PROBE createReturnTopLevelKeys :: ["asset"]
PROBE createReturn_id :: undefined
PROBE createReturnRaw :: {"asset":{"id":359,"company_id":13,"asset_layout_id":1,"slug":"b3c549167ca9","name":"ZZ-probe-defect-1", ...
PROBE resolvedId :: 359
PROBE pre-update :: {"name":"ZZ-probe-defect-1","updated_at":"2026-09-13T03:00:27.935Z"}
PROBE updateThrew :: NO - resolved without error
PROBE updateReturnTopLevelKeys :: ["asset"]
PROBE updateReturn_id :: undefined
PROBE post-update :: {"name":"STALE-LANDED","updated_at":"2026-09-13T03:00:28.054Z"}
PROBE STALE_WRITE_LANDED :: true
PROBE company13AssetsWithProbe :: 1
PROBE accountAssetsAfterCleanup :: 20
PROBE cleanupOk :: true
```

Reading: DEFECT 2 is confirmed - `create` returned top-level key `["asset"]` and `createReturn_id :: undefined`,
so the caller gets an envelope typed as `Asset` (the probe had to reach into `created.asset.id`). DEFECT 1 is
confirmed - the stale update `updateThrew :: NO - resolved without error`, and the read-back shows
`STALE-LANDED` with `updated_at` advanced (03:00:27.935Z -> 03:00:28.054Z): the write LANDED under a guard the
caller believed was active.

## 3. AFTER - same repro on the rebuilt `dist`

Command:

```
npm run build && HUDU_BASE_URL=https://hudu-sandbox.example.com HUDU_API_KEY=*** \
  node /tmp/asset_probe_after.mjs
```

Observed (verbatim; "..." only where the refusal text repeats verbatim):

```
AFTER layoutIds :: [1,2]
AFTER accountAssetsBeforeProbe :: 20
AFTER createReturn_id :: 360
AFTER createReturn_shapeOk :: true
AFTER pre-refusal :: {"name":"ZZ-probe-after","updated_at":"2026-09-13T03:02:51.934Z"}
AFTER refusal:update :: HuduConfigError [CONFIG_ERROR] assets.update: expectedUpdatedAt compares an existing revision, so it applies to update (PUT) only - this path records staleCheck "unavailable" and would never run the guard.
AFTER refusal:moveLayout :: HuduConfigError [CONFIG_ERROR] assets.moveLayout: expectedUpdatedAt compares an existing revision, ... would never run the guard.
AFTER refusal:archive :: HuduConfigError [CONFIG_ERROR] assets.archive: expectedUpdatedAt compares an existing revision, ... would never run the guard.
AFTER refusal:unarchive :: HuduConfigError [CONFIG_ERROR] assets.unarchive: expectedUpdatedAt compares an existing revision, ... would never run the guard.
AFTER refusal:delete :: HuduConfigError [CONFIG_ERROR] assets.delete: expectedUpdatedAt compares an existing revision, ... would never run the guard.
AFTER post-refusals-record-untouched :: {"name":"ZZ-probe-after","updated_at":"2026-09-13T03:02:51.934Z","archived":false}
AFTER refusal:create :: HuduConfigError [CONFIG_ERROR] assets.create: expectedUpdatedAt compares an existing revision, ... would never run the guard.
AFTER updateWithoutGuard_id :: 360
AFTER updateWithoutGuard :: {"name":"AFTER-NO-GUARD-OK","updated_at":"2026-09-13T03:02:52.089Z","landed":true}
AFTER moveLayoutReturn_id :: 360
AFTER moveLayoutLanded :: true
AFTER accountAssetsAfterCleanup :: 20
AFTER cleanupOk :: true
AFTER inventory :: {"companies":21,"articles":4,"asset_layouts":4,"websites":2,"groups":1,"users":1,"lists":1,"folders":1,"networks":1}
AFTER activity_logs_count :: 466
```

Reading:
- each guarded path now refuses with `HuduConfigError`/`CONFIG_ERROR` and the message NAMES the operation;
- `post-refusals-record-untouched` is identical to `pre-refusal`, including `updated_at` - the stale write no
  longer lands;
- `refusal:create` proves the refusal also precedes the POST (no probe asset was created by it - the cleanup
  count is unchanged);
- (b) `updateWithoutGuard :: landed: true` - an update WITHOUT `expectedUpdatedAt` still works unchanged, and it
  is the only call that moved `updated_at`;
- (c) `createReturn_id :: 360`, `updateWithoutGuard_id :: 360`, `moveLayoutReturn_id :: 360` - all three return a
  real id from the live WRAPPED body, and `createReturn_shapeOk :: true` confirms there is no `asset` key left on
  the returned object.

## 4. Comparison: the guard on a path that DOES implement it

Command: `node /tmp/restore_company13.mjs` (also the company-13 restore; see section 7).

```
FIX company13-now :: {"id":13,"name":"ZZ-should-not-land","updated_at":"2026-09-13T03:02:52.342Z"}
FIX company13-restored :: {"name":"Amazon Web Services","id":13}
FIX company13-verified :: {"name":"Amazon Web Services","url":"/c/20350f01a99a"}
FIX companies.update-stale :: StaleObjectError [STALE_OBJECT] Stale object: companies 13 was not at the expected revision for companies.update (expected updated_at 2000-01-01T00:00:00.000Z, found 2026-09-13T03:03:02.031Z)
FIX company13-after-stale-attempt :: Amazon Web Services
FIX companies :: 21
```

`companies.update(13, data, { expectedUpdatedAt })` throws `StaleObjectError [STALE_OBJECT]` and leaves the
record untouched (`company13-after-stale-attempt :: Amazon Web Services`). This is the behaviour assets now
approximates at the refusal level and the contrast the defect report described.

## 5. Unit tests

New block `AssetsResource write paths - expectedUpdatedAt refusal and response unwrap (live defects)` (10 new
tests, all passing):

- (a) a table-driven test per guarded path (`assets.create`, `assets.update`, `assets.delete`, `assets.archive`,
  `assets.unarchive`, `assets.moveLayout`): the call throws `HuduConfigError` with `code === 'CONFIG_ERROR'`, the
  message names the operation and mentions `expectedUpdatedAt`, and `spy.calls` is `toHaveLength(0)` - NO request
  is issued;
- (b) `an asset update WITHOUT expectedUpdatedAt still works (no extra request, no refusal)` - exactly one PUT;
- (c) `create/update/moveLayout return a record with a real id for a WRAPPED body` and `... for a FLAT body` -
  both shapes yield `id === asset.id` (the flat case has no live counterpart: the vendor always wraps on this
  tenant, so the flat branch is unit-only evidence - marked UNVERIFIED live);
- plus `update with a MATCHING expectedUpdatedAt is still refused on assets` - the refusal is not conditional on
  the timestamp being wrong.

Two EXISTING tests encoded the OLD behaviour and were rewritten (not deleted, not skipped, not weakened) - this
is the disclosure the brief asked for:

- `update (raw) returns raw body as-is` asserted `expect(res).toEqual({ asset })`. That assertion IS defect 2.
  It is now `update unwraps the live { asset } envelope and returns the record`, asserting `toEqual(asset)` and
  `id === asset.id`. The request-shape assertions (URL, method, `{ asset: {...} }` body) are unchanged.
- `update wraps the body in { asset } while moveLayout keeps its own shape (A-1/C1)` asserted
  `expect(updated).toEqual({ asset })` and `expect(moved).toEqual({ wrapped: true, asset })`. Both encode the
  old pass-through; they now assert the unwrapped record, with the same request-shape assertions kept.

No test was skipped or removed. `test/resources/assets.test.ts`: 101 tests -> 111 tests, all green.

## 6. Gates (after the change)

```
npm run build           -> exit 0
npx tsc --noEmit        -> TSC_OK
npm run lint            -> LINT_OK (eslint src test, 0 problems)
npm test                -> Test Files 50 passed (50); Tests 1627 passed (1627)
node scripts/check-capabilities.mjs -> PASS - 0 failures; rows=225 scoped=225 registryRecords=225 warnings=66
                                        (the 66 warnings are the pre-existing [unplanned-surface] listAll/listPages notes)
```

## 7. Choices made, what changed in the tenant, and what is UNVERIFIED

**Choice: refuse, do not implement the guard.** The registry advertises `staleCheck: none` for these rows, so
implementing a read-then-compare guard on `assets.update` would change the published contract (a new extra GET,
a new failure mode) without a plan change. The project's established policy - already applied to create/delete/
archive - is that an option a path cannot honour is REFUSED, never silently ignored. So
`refuseExpectedUpdatedAtOutsideUpdate(operation, opts)` is called at the top of each path, naming the operation,
and the caller is told (in the message and in the source doc comments) to re-read `updated_at` and compare it
itself. A matching `expectedUpdatedAt` is refused too: refusing only when the value is stale would be a false
guard, and a caller cannot tell which case it hit from the outside.

**Scope: six paths, not four.** The brief named `update`, `moveLayout`, `archive`, `unarchive`. `create` and
`delete` are hand-rolled on the same `AssetWriteOptions` and had the identical silent-drop defect, and
`BaseResource.createOne`/`deleteOne` already refuse `expectedUpdatedAt` for every other resource. Applying it to
all six keeps the assets resource from being the one inconsistent surface, so all six were changed - a superset
of the briefed four, no behaviour removed. Live proof for all six is in section 3.

**Tenant disclosure (my probe, not the fix).** `companies.update` takes THREE arguments (`opts` is the 3rd), and
my comparison probe passed `expectedUpdatedAt` as a 4th, so the option was dropped **by my script** and a real
rename of company 13 to `ZZ-should-not-land` landed (03:02:52.342Z). I detected it from
`company13-untouched :: false`, restored the original name in the same run
(`company13-restored :: Amazon Web Services`), and re-tested the guard correctly as the 3rd argument, which then
threw `STALE_OBJECT` without writing. Company 13's `name` and `url` are back to `Amazon Web Services` /
`/c/20350f01a99a`; its `updated_at` and one extra activity-log entry are the unavoidable trace of that slip and
of the restore. No other pre-existing record was touched.

**Final inventory** (see the `AFTER inventory` line above, measured after all probe records were deleted):

| Resource | Expected | Observed |
|----------|----------|----------|
| companies | 21 | 21 |
| articles | 4 | 4 |
| asset_layouts | 4 | 4 |
| websites | 2 | 2 |
| groups | 1 | 1 |
| users | 1 | 1 |
| lists | 1 | 1 |
| folders | 1 | 1 |
| networks | 1 | 1 |
| activity_logs | 466 | 466 |
| assets (account-wide; not in the brief's list) | 20 at session start | 20 (`FINAL accountAssets :: 20`), `cleanupOk :: true` |
| probe-named assets left behind | 0 | 0 (`FINAL probeNamedAssets :: []`) |

Both probe assets were deleted by the probes themselves (`cleanupOk :: true` after each). The coverage sweep ran
LAST and its writes are dry-run only; a separate post-sweep check (`node /tmp/final_inventory.mjs`) re-measured
the whole inventory and found `21/4/4/2/1/1/1/1/1/466`, `accountAssets :: 20`, no probe-named asset, and
company 13 back to `Amazon Web Services`. The probe scripts and their JSON output live in `/tmp`; my probes read the key from the process environment
only (`HUDU_API_KEY=... node /tmp/...`), so no credential was written to any file in this repo. A `.env.live`
path does exist in the working tree - it is not created or written by me, and it does not appear in
`git status --short`, so it is ignored or tracked-and-unchanged (a `stat` on it was refused by the safety guard,
which is correct behaviour; I did not work around it).

**UNVERIFIED**
- The FLAT-response branch of `unwrapCreated`/`unwrapSingle` for these three writers is unit-tested only: this
  tenant wraps on create, update and move_layout, so no live flat body was observed.
- `assets.archive`/`assets.unarchive` refusal is proven for the option; their SUCCESS path was not exercised
  live (the probe asset was never archived for real - `archived: false` throughout), so the archive write itself
  remains covered by unit tests only.
- The refusal is proven for a JS caller passing the key; the DECLARED `AssetWriteOptions` type was deliberately
  left without `expectedUpdatedAt` (out of scope: that is a contract/typing change, not a guard fix).
- The coverage sweep's `assets.create` row is a fixture artefact (see section 8); its refusal is unrelated to
  this change.

## 8. Coverage read-out (optional sweep, dry-run only for writes)

Command: `node scripts/live-coverage.mjs --json /tmp/assets-write-coverage.json` (writes are dry-run only).

```
operations: 225  DRY_OK 51  LIVE_OK 63  SKIP 95  LIVE_REFUSED 15  THREW 1
DRY_OK        assets.archive        dry-run issued, no write
DRY_OK        assets.delete         dry-run issued, no write
DRY_OK        assets.moveLayout     dry-run issued, no write
DRY_OK        assets.unarchive      dry-run issued, no write
DRY_OK        assets.update         dry-run issued, no write
LIVE_REFUSED  assets.create         CONFIG_ERROR: assets.create requires a positive integer companyId, got "[object Object]"
LIVE_OK       assets.get            read id 332
LIVE_OK       assets.list           3 row(s)
SKIP          assets.resolve / getContext / search / findBySerial   no live row of this resource to resolve
SKIP          assets.listAcrossCompanies   unclassified method shape
```

Note on the `assets.create` row: its refusal is the pre-existing `requireCompanyId` check firing on the sweep's
own fixture (it passes an object where the sweep means an id) - `opts.expectedUpdatedAt` is undefined on that
call, so this row is unrelated to this change and is not a regression from it. Every assets WRITE row ran as a
dry-run and issued no write. The `SKIP` rows are the sweep's own seeder gaps.
