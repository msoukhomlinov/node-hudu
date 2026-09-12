# impl-B2 — implement report (Group B, resources: rack_storage_items, relations, flags, flag_types)

Run: node-hudu-backfill-20260912 · branch `feat/agent-execution-layer` · 24 plan rows owned
(18 primitives + 6 helpers), 85 plan test titles, 0 missing.

## Files changed (all inside my ownership — no shared, generated or coord-owned file touched)

| Path | Status | Lines |
|---|---|---|
| src/resources/rack_storage_items.ts | modified | 219 |
| src/resources/relations.ts | modified | 308 |
| src/resources/flags.ts | modified | 257 |
| src/resources/flag_types.ts | modified | 314 |
| src/types/rack_storage_item.ts | modified (+RackStorageItemSummary) | 59 |
| src/types/relation.ts | modified (+RelationSummary, +RelationEndpoint) | 58 |
| src/types/flag.ts | modified (+FlagSummary) | 41 |
| src/types/flag_type.ts | modified (+FlagTypeSummary) | 37 |
| test/resources/rack_storage_items.test.ts | created | 292 |
| test/resources/relations.test.ts | created | 338 |
| test/resources/flags.test.ts | created | 318 |
| test/resources/flag_types.test.ts | created | 339 |

Not touched (verified): src/types/common.ts, src/types/index.ts, src/http.ts, src/errors.ts,
src/config.ts, src/logger.ts, src/resources/base.ts, src/index.ts, scripts/**, capabilities*.*,
MCP_TOOL_MANIFEST.md, package.json, tsup/vitest config, examples/**, .run/** (this report excepted),
README/CHANGELOG/docs. No git commit, push, `--no-verify`, `.skip`, or threshold change.

## Commands run (exact) and exit codes

| Command | Exit |
|---|---|
| `npx tsc --noEmit` | **0** (project-wide green, incl. my 12 files) |
| `npx eslint <my 8 src files> <my 4 test files>` | **0** |
| `npx vitest run test/resources/rack_storage_items.test.ts test/resources/relations.test.ts test/resources/flags.test.ts test/resources/flag_types.test.ts` | **0** — 4 files, **93 tests passed** (21 / 22 / 24 / 26) |
| `node /tmp/gen-sim/sim.mjs` (read-only simulation of the generator's resolveProps; in /tmp) | 0 — see finding 1 |

Not run (forbidden by my brief): `npm run capabilities:build`, `capabilities:check`, `node scripts/*.mjs`,
`npm run build`, `npm pack`, bare `vitest run`, `npm test`.

## Plan test titles — implemented vs missing

85/85 titles present, verified by static comparison of every row's `tests[].title` against the
`it('<title>')` strings of my four files (exact match, no duplicate titles in a file).

Helpers (all 6 rows):
- `rack_storage_items.resolve`: id, id-miss, unsupported-kind, compact, expand
- `relations.resolve`: id, id-miss, truncated, compact
- `relations.findByEndpoints`: match, direction, empty, limit
- `flags.resolve`: id, id-miss, unsupported-kind, compact
- `flags.findByFlagable`: match, empty, limit
- `flag_types.resolve`: id, id-miss, unique, miss, compact, expand
Primitives (18 rows): every `get`/`list`/`create`/`update`/`delete` row title, including
`never sends page/page_size to the non-paginated endpoint`, `normalises a 404 into NOT_FOUND`,
`sends page/page_size and stops on a short page`, `unwraps the PUT response by singleKey`,
`resolves void after a successful delete`, the three dry-run titles, `sends the expectedUpdatedAt
guard and maps a mismatch to STALE_OBJECT` (only on the two rows where the plan declares
`staleCheck: updated_at` — flags.update and flag_types.update) and `surfaces a correlation id on the
success path and the error path`.

Extra tests beyond the plan rows (37 of the 93): resolutionDetails for every helper, refusal of an
unsupported identifier kind, `allowClientScan: false`, ambiguity + truncation, malformed endpoint /
flagable refusals, non-404 error propagation, and the `limit` bound above 100 / below 1 / non-integer.

## Behaviour implemented (summary)

- Helpers use `BaseResource.boundedScan` / `pageFetcher` / `requireResolved` / `assertNotStale` /
  `buildDryRunResult`. No scan or pagination loop is re-implemented, and no `Promise.all` is used.
- Compact by default, `{ expand: true }` → full record, `{ resolutionDetails: true }` → `Resolution<T>`.
  Additive only: every existing primitive signature/return/behaviour is preserved (new params are
  extra overloads).
- `resolve` honesty: `{ id }`/numeric-id miss throws `NOT_FOUND`; `null` only after a complete scan
  (flag_types slug/name); a cap that stopped the search throws `RESOLUTION_TRUNCATED`
  (relations.resolve at 4 pages, flag_types filtered lookups); ≥2 exact matches throw
  `RESOLUTION_AMBIGUOUS` with candidate ids in `resourceIds`; an unsupported identifier kind throws
  `HuduConfigError` (category validation) naming the accepted kinds, with **no request issued**.
- Limits: relations.findByEndpoints and flags.findByFlagable honour `limit` (default 25, hard max 100,
  `HuduConfigError` above/below/non-integer) in exactly one HTTP request.
- Non-paginated `/rack_storage_items` never receives `page`/`page_size` from any path (asserted).
- Dry-run never writes (asserted with `spy.calls).toHaveLength(0)`). The opt-in stale guard is wired
  **only** on `update` (through `BaseResource.updateOne`): it reads the current record first and throws
  `STALE_OBJECT` (412 / conflict / not retryable) on a mismatch, so no PUT is issued. `create` and
  `delete` carry no guard (`staleCheck: "unavailable"`, coordinator ruling 2026-09-12) and pass their
  `opts` through to the base helpers unchanged.

## Gaps and findings

1. **BLOCKER for the batch gate — `helper-compact-drops` cannot be satisfied by the mandated
   overload pattern (affects all four groups, not just mine). UNVERIFIED end-to-end (I must not run
   `scripts/*.mjs`), but measured for my 6 helper rows by replaying the generator's own logic
   (`outputSchema()` → `resolveProps()` → last-declared method wins) in /tmp:
   `rack_storage_items.resolve`, `relations.resolve`, `relations.findByEndpoints`, `flags.resolve`,
   `flags.findByFlagable`, `flag_types.resolve` → `dropsUnresolved=true`, `drops=[]`.
   Cause: `generate-capabilities.mjs` takes the LAST method declaration's return type (the
   implementation signature) and `resolveProps()` resolves only a single type name or a
   `Partial/Required/Omit/Pick` wrapper — never a union. The design-doc pattern requires the
   implementation signature to return a union (`X | XSummary | Resolution<XSummary> | null`) because
   TS 2394 forbids anything narrower (verified: a scratch file with the compact overload and an
   implementation returning `Full | null` fails with TS2394).
   Recommended fix in `scripts/generate-capabilities.mjs` `outputSchema()`: when `resolveProps(rt)`
   is null, split `rt` on `|`, strip a trailing `[]`, `resolveProps()` each member, and use the first
   member whose props are a superset of the compact shape's props (my unions list the full record type
   first, so "first resolvable member" also works). Without it, every compact helper row in groups
   A–D fails `capabilities:check`.
2. **`staleCheck` is operation-shaped (coordinator ruling applied).** `updated_at` is declared only on
   my two `update` rows (`flags.update`, `flag_types.update`); every create/delete row is
   `"unavailable"`. Final shape of the guard in my files, after the second ruling:
   - `flags.update` / `flag_types.update`: the base `updateOne` guard reads the current record and
     throws `STALE_OBJECT` (412 / conflict, not retryable) on a mismatch, so only the guard GET is
     issued; a matching revision proceeds GET then PUT. The `.stale` plan title lives here.
   - `create` / `delete` on all four resources: `expectedUpdatedAt` is **refused** with
     `HuduConfigError` (`code: CONFIG_ERROR`, `category: validation`, no request issued) — never
     silently ignored and never a false `STALE_OBJECT`. The create-path refusal I wrote in my first
     pass is restored (it was already `HuduConfigError`), and the delete path now refuses too instead
     of ignoring the option.
   - `rack_storage_items.update`: **also refuses** (an extension of the ruling, marked *UNVERIFIED* as
     a coordinator preference). This resource declares `staleCheck: "unavailable"` because
     `RackStorageItem` has no `updated_at` field, so letting the base guard run would compare against
     `undefined` and return a guaranteed false `STALE_OBJECT`. Refusal keeps the contract honest; if
     the coordinator prefers the base pass-through there, deleting one `refuseExpectedUpdatedAt` call
     and its 1 test is the whole change.
3. **Unsupported-identifier kind uses `HuduConfigError`** (unaffected by the ruling) (`code: 'CONFIG_ERROR'`, `category:
   'validation'`, no HTTP status because no request was made). The `errors` columns of
   `rack_storage_items.resolve` and `flags.resolve` list no validation code, so the registry will not
   advertise it — a plan-column gap, not a behaviour gap. I chose `HuduConfigError` over
   `ValidationFailedError` because the latter hard-codes HTTP 400 for a call that never reached the wire.
4. **`relations.findByEndpoints` and `flags.findByFlagable` cannot throw `RESOLUTION_AMBIGUOUS` /
   `RESOLUTION_TRUNCATED`** although their plan `errors` columns list them: they return *arrays* of
   every vendor-filtered match (two records may be related more than once), so there is no single
   match to disambiguate. Row-template artifact — the columns should drop those two codes for these rows.
5. **`resolution.basis: server-filter` on `rack_storage_items.resolve` and `flags.resolve`** does not
   match the implemented path: both resources have no identifying server filter, so an id is fetched
   directly and `resolutionDetails` reports `resolutionCost: 'direct'` (the plan's own tests demand
   "fetches by id without a scan"). The `basis` column looks template-derived; the registry will
   advertise `server-filter`, and the row's `metadata.usage` says id-only.
6. **Sibling shared module.** `src/resources/agent-layer-helpers.ts` (created concurrently by another
   implementer, not in my ownership) exports `helperLimit`, `identifierError`, `requirePositiveId`,
   `decideResolution`, `refuseClientScan`, `numericIds` — overlapping my local `helperLimit` /
   `describeValue`. I kept local copies rather than importing a file another agent owns and can still
   change. UNVERIFIED whether it is intended as the batch-wide home; consolidation is a coordinator call.
7. **`src/types/index.ts` still needs 5 additive exports** for my files:
   `FlagSummary` (./flag.js), `FlagTypeSummary` (./flag_type.js), `RelationSummary` and
   `RelationEndpoint` (./relation.js), `RackStorageItemSummary` (./rack_storage_item.js). Per the
   coordinator steer I did not edit the barrel; my files import from their own type file.
8. **Not measured: per-file coverage.** I did not run coverage (it needs the project-wide run my brief
   forbids). Every branch I could enumerate in my 12 files is asserted by a test; one dead-ish branch
   remains in `flag_types.resolve` (`hit.candidates === undefined`, unreachable because a hit always
   carries candidates). *UNVERIFIED* that the global 97/94/83/97 thresholds hold once all 7
   implementers' files are collected.
9. **Not run: `npm run capabilities:check`** (coordinator runs it at the batch gate). Title presence
   and method coverage were verified statically here, not by the gate itself. *UNVERIFIED*.

## Deliberate, reported deviations from the design doc

- `MutationOptions` stays the shared option bag for `create`/`delete` (they need `dryRun`); their
  JSDoc states that `expectedUpdatedAt` is refused there because `staleCheck` is `"unavailable"`. The
  guard itself lives only on `update` (the base helper), and `refuseExpectedUpdatedAt()` is a local
  function per resource file that names the path, the reason and the supported alternative.
- Ruling 3 noted (RESOLUTION_AMBIGUOUS removed from array-returning helper rows) — no code change
  needed: those helpers never threw it.
- Ruling 2 noted (CONFIG_ERROR added to the helper rows' errors) — no code change needed.
- Ruling 5 noted: I did not touch `src/types/index.ts`; my 5 exports are the coordinator's to add.
- `relations.resolve` accepts only a numeric id (the doc's "client-scan" basis) — no inexact filter
  exists for relations, so `RESOLUTION_AMBIGUOUS` is unreachable there, and `allowClientScan: false`
  throws `RESOLUTION_TRUNCATED` because the scan is the only lookup path.
- `flag_types.resolve` performs at most two bounded filtered lookups per call (slug, then exact name
  for a bare value) and reports `scanned` as the sum, `resolutionCost: 'server-filter'`.
