# Impl: resolution truncation lie (CRITICAL)

Status: FIXED + VERIFIED (unit, static, live). Branch `feat/agent-execution-layer` (unchanged, uncommitted).
Credentials were passed as `HUDU_BASE_URL` / `HUDU_API_KEY` env vars only; the key is never written here.

## Findings / result table

| Item | Result | Evidence |
|---|---|---|
| Root cause | CONFIRMED: a decided match was returned with hardcoded `scanTruncated: false` before the scan's own truncation flag was consulted | `src/resources/companies.ts::filterScan` returned `{value: only, scanTruncated: false}` above `if (scan.scanTruncated)` |
| One shared guard instead of 27 copies | DONE: `assertScanDecided()` in `src/resources/agent-layer-helpers.ts` | 9 call sites (grep below) |
| Sites fixed (single match on a truncated scan now throws) | 9 decision helpers: companies, articles, assets, asset_passwords, asset_layouts, folders, groups, websites, password_folders | `grep -n 'assertScanDecided(' src/resources/*.ts` |
| Sites aligned to rule bullet 3 (ambiguous wins over truncated) | 6: `decideResolution` + `decide()` in vlans, networks, rack_storages, vlan_zones, ip_addresses | reorder of the `if (truncated)` block after the `matches.length > 1` block |
| Sites already correct (verified, no change) | `requireResolved` paths (photos, flag_types), the two-pass `scanUnique` (label_types, users, labels, lists), direct `byId` fetches, `decideResolution` after this reorder | `base.ts::requireResolved`, `label_types.ts::scanUnique` |
| Unit tests | 10 new cases in 9 files (truncated+1 match throws; complete scan still returns) | `Test Files 50 passed (50) / Tests 1617 passed (1617)` |
| `npx tsc --noEmit` | 0 | `TSC_OK` |
| `npm run lint` | 0 (eslint src test) | `LINT_OK` |
| `npm test` | 0 failures, 1617 passed (was 1607) | see below |
| `node scripts/check-capabilities.mjs` | PASS 0 failures | `PASS — 0 failures; rows=225 scoped=225 registryRecords=225 warnings=66` |
| `node scripts/live-smoke.mjs` before (HEAD worktree) | TOTAL 40 PASS 40 FAIL 0 | run in `/tmp/hudu-before` built from HEAD |
| `node scripts/live-smoke.mjs` after (fixed dist) | TOTAL 40 PASS 40 FAIL 0 | see below |
| Live repro before -> after | `value 3 / scanTruncated false` -> `THROW RESOLUTION_TRUNCATED` | `/tmp/probe18.mjs` verbatim outputs below |
| Cleanup | duplicate company deleted; 21 companies, 0 `ZZ Dup Domain`, websites 2, groups 1 | `node /tmp/verify-cleanup.mjs` |
| No commits / no branch switch / no push | respected (worktree at HEAD used for the before-build, then removed) | `git branch --show-current` = feat/agent-execution-layer |

## Root cause

`boundedScan` reports the truth: a cap that stops the walk returns `{value: null, scanTruncated: true}`. The
decision code above it did not read that flag before answering:

```ts
const only = exact.length === 1 ? (exact[0] as Company) : undefined;
if (only !== undefined) {
  return { value: only, resolutionCost: 'server-filter', scanned: fetched.length, scanTruncated: false, ... };
}
if (scan.scanTruncated) { throw ResolutionError.truncated(...); }   // unreachable for a found match
```

So a scan that the cap stopped after page 1 returned the ONE match it happened to see as a confident hit with
`scanTruncated: false`. The caller cannot tell it apart from a complete scan, which is the CRITICAL lie.

## Fix

One guard, in `src/resources/agent-layer-helpers.ts`:

```ts
export function assertScanDecided(opts: { operation, scanned, truncated, detail?, identifier? }): void {
  if (!opts.truncated) return;
  throw ResolutionError.truncated(
    `${opts.operation}: the bounded client scan was truncated after ${opts.scanned} record(s)` +
      `${opts.detail === undefined ? '' : ` while resolving ${opts.detail}`}; a truncated scan cannot prove ` +
      'uniqueness, so the record may exist beyond the resolution cap and cannot be decided.',
    { operation: opts.operation, resourceIds: numericIds(opts.identifier), suggestedAction: ... },
  );
}
```

Rule now enforced at every decision site (unchanged signatures, return shapes and error codes):

1. `exact.length > 1` -> `RESOLUTION_AMBIGUOUS` with `resourceIds` (unchanged, wins even when truncated);
2. `assertScanDecided(...)` -> `RESOLUTION_TRUNCATED` when the cap stopped the scan (the fix: this now runs
   BEFORE a single match is returned);
3. one exact match on a complete scan -> the match with `scanTruncated: false` (unchanged);
4. zero matches -> `RESOLUTION_TRUNCATED` when capped, `null` only after a complete scan (unchanged).

`decideResolution` and the five `decide()` copies (vlans, networks, rack_storages, vlan_zones, ip_addresses)
checked `truncated` BEFORE ambiguity; they are reordered so bullet 1 is uniform. All 1617 tests still pass.

### Files changed (src)
```
 src/resources/agent-layer-helpers.ts    | 56 ++++++++++++++++++++++++++-------
 src/resources/articles.ts               | 11 +++----
 src/resources/asset_layouts.ts          | 13 +++-----
 src/resources/asset_passwords.ts        | 11 +++----
 src/resources/assets.ts                 | 12 +++----
 src/resources/companies.ts              | 11 +++----
 src/resources/folders.ts                | 17 +++++-----
 src/resources/groups.ts                 | 16 +++++-----
 src/resources/ip_addresses.ts           | 22 +++++++------
 src/resources/networks.ts               | 16 +++++-----
 src/resources/password_folders.ts       | 16 +++++-----
 src/resources/rack_storages.ts          | 16 +++++-----
 src/resources/vlan_zones.ts             | 16 +++++-----
 src/resources/vlans.ts                  | 16 +++++-----
 src/resources/websites.ts               | 17 +++++-----
```
Call sites:
```
src/resources/articles.ts:379:    assertScanDecided({ operation, scanned: fetched.length, truncated: scan.scanTruncated });
src/resources/asset_layouts.ts:280:    assertScanDecided({ operation, scanned: fetched.length, truncated: scan.scanTruncated });
src/resources/asset_passwords.ts:361:    assertScanDecided({ operation, scanned: fetched.length, truncated: scan.scanTruncated });
src/resources/assets.ts:556:    assertScanDecided({ operation, scanned: fetched.length, truncated: scan.scanTruncated });
src/resources/companies.ts:446:    assertScanDecided({ operation, scanned: fetched.length, truncated: scan.scanTruncated });
src/resources/folders.ts:255:    assertScanDecided({ operation, scanned: scan.scanned, truncated: scan.scanTruncated, detail });
src/resources/groups.ts:248:    assertScanDecided({ operation, scanned: scan.scanned, truncated: scan.scanTruncated, detail });
src/resources/password_folders.ts:305:    assertScanDecided({ operation, scanned: scan.scanned, truncated: scan.scanTruncated, detail });
src/resources/websites.ts:324:    assertScanDecided({ operation, scanned: scan.scanned, truncated: scan.scanTruncated, detail });
```

## Tests added (all in existing files, no test weakened, skipped or deleted)

Per fixed decision helper: a page that is FULL and contains exactly one exact match, answered for 4 pages ->
the cap stops the scan -> `RESOLUTION_TRUNCATED`:

| Test file | Case |
|---|---|
| companies.test.ts | capped+`limit: 1` (the live repro, 1 row per page) and the default-caps full page both throw; plus a complete-scan case that still returns the match with `scanTruncated: false` |
| articles.test.ts | 25 rows, one exact slug, capped -> throws |
| assets.test.ts | 25 rows, one exact `primary_serial`, capped -> throws |
| asset_passwords.test.ts | 25 rows, one exact slug, capped -> throws |
| asset_layouts.test.ts | full pages, one exact slug, "server" -> throws |
| folders.test.ts / groups.test.ts / websites.test.ts / password_folders.test.ts | full 25-row page with one exact match, then full non-matching pages, default caps -> throws |

## Verification (verbatim commands + observed output)

BEFORE, built from HEAD in a throwaway worktree (`git worktree add --detach /tmp/hudu-before HEAD`,
`ln -s node_modules`, `npm run build`) and probed with a copy of `/tmp/probe18.mjs` pointed at that dist:

```
$ node /tmp/probe18-before.mjs
two companies now share https://www.microsoft.com -> ids 3 and 118
maxScanPages:1 + limit:1           -> value 3 | scanTruncated false | scanned 1 | candidates 3
maxScanPages:1 + no limit          -> THROW RESOLUTION_AMBIGUOUS companies.findByDomain: 2 companies match the identifier exactly, so i
default caps + limit:1             -> THROW RESOLUTION_AMBIGUOUS companies.findByDomain: 2 companies match the identifier exactly, so i
default caps + no limit            -> THROW RESOLUTION_AMBIGUOUS companies.findByDomain: 2 companies match the identifier exactly, so i
cleanup deleted 118
```

BEFORE live harness (same worktree, so the "before" number is real and not a stale-dist refusal):

```
$ (cd /tmp/hudu-before && node scripts/live-smoke.mjs | tail -3)
========================================================================================================
TOTAL 40  PASS 40  FAIL 0  SKIP 0
```

AFTER `npm run build` (fixed source):

```
$ npm run build >/tmp/b2.log 2>&1; echo BUILD=$?
BUILD=0
$ npx tsc --noEmit && echo TSC_OK
TSC_OK
$ npm run lint && echo LINT_OK
> node-hudu@0.3.0 lint
> eslint src test
LINT_OK
$ node scripts/check-capabilities.mjs | tail -1
PASS — 0 failures; rows=225 scoped=225 registryRecords=225 warnings=66
$ node /tmp/probe18.mjs
two companies now share https://www.microsoft.com -> ids 3 and 129
maxScanPages:1 + limit:1           -> THROW RESOLUTION_TRUNCATED companies.findByDomain: the bounded client scan was truncated after 1
maxScanPages:1 + no limit          -> THROW RESOLUTION_AMBIGUOUS companies.findByDomain: 2 companies match the identifier exactly, so i
default caps + limit:1             -> THROW RESOLUTION_AMBIGUOUS companies.findByDomain: 2 companies match the identifier exactly, so i
default caps + no limit            -> THROW RESOLUTION_AMBIGUOUS companies.findByDomain: 2 companies match the identifier exactly, so i
cleanup deleted 129
$ node scripts/live-smoke.mjs | tail -3
========================================================================================================
TOTAL 40  PASS 40  FAIL 0  SKIP 0
$ npm test | tail -6
 Test Files  50 passed (50)
      Tests  1617 passed (1617)
```

Note: the capped + `limit: 1` case now throws `RESOLUTION_TRUNCATED` rather than `AMBIGUOUS` because with
`page_size=1` the truncated scan saw exactly one match; the two-match case cannot be observed under that cap.
With default caps the same call sees both matches and throws `RESOLUTION_AMBIGUOUS` (unchanged).

Cleanup (final state, after every probe run):

```
$ node /tmp/verify-cleanup.mjs
companies count = 21
ZZ Dup Domain rows = none
id 3 website = https://www.microsoft.com
websites count = 2
groups count = 1
$ git worktree remove /tmp/hudu-before --force && git worktree list
/Users/maxs/gitrepos/node-hudu 9e18713 [feat/agent-execution-layer]
```

The 21 pre-existing companies, 2 websites, 1 group, 1 user and 1 list were never modified or deleted; only the
throwaway duplicate company created by the probe was deleted each run. `activity_logs.deleteAll` and
`magic_dash.delete` were only exercised by the harness in dry-run/policy-denied paths (C28/C29 PASS).

## Gaps / UNVERIFIED

- UNVERIFIED: the fixed behavior was proven live for `companies.findByDomain` only. The other 8 fixed
  resources are proven at unit level (mocked HTTP), not against the live tenant.
- UNVERIFIED: the pre-existing `decideResolution`/`decide()` ordering (truncated before ambiguous) may have
  been load-bearing for an external caller; no test covered it, so the reorder is behavior-visible for a
  truncated scan that also has 2+ matches: it now throws RESOLUTION_AMBIGUOUS instead of RESOLUTION_TRUNCATED.
- Other uncommitted changes in the tree (`base.ts`, `label_types.ts`, `users.ts`, `labels.ts`, `lists.ts` and
  `.run/live/helpers-resolution.md`) are a sibling agent's 200-with-null-body fix, not mine. My test/lint run
  covers the combined tree; the src files I list above are the only ones this task touched.
- No commit was made (coordinator commits).
