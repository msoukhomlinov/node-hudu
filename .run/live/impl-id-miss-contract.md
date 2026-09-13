# Live contract gaps: missing record (F2) and missing identifier (F4)

Branch `feat/agent-execution-layer` (not switched, not committed, not pushed).
Live tenant: `https://hudu-sandbox.example.com`, Hudu 2.45.1, `dist/` rebuilt before every live run.
All five probes used `MISS = 99999999` and the real harness `scripts/live-smoke.mjs`.

## F2 — reproduced BEFORE the fix

Command (probe script `/tmp/probe-miss.mjs`, run against the pre-fix `dist/`):

```
node /tmp/probe-miss.mjs
```

Observed:

| Resource | `get(99999999)` | `resolve(99999999)` | `resolve({id: 99999999})` |
|---|---|---|---|
| articles | RETURNED null | THREW TypeError: Cannot read properties of null (reading 'id') | THREW TypeError: Cannot read properties of null (reading 'id') |
| assetLayouts | RETURNED null | THREW TypeError: Cannot read properties of null (reading 'id') | THREW TypeError: Cannot read properties of null (reading 'id') |
| assetPasswords | RETURNED null | THREW TypeError: Cannot read properties of null (reading 'id') | THREW TypeError: Cannot read properties of null (reading 'id') |
| folders | RETURNED null | RETURNED null | RETURNED null |
| websites | RETURNED null | RETURNED null | RETURNED null |

The `TypeError`s carried no `code`, no `status`, no `category` and no `resourceIds`
(`name=TypeError code=undefined status=undefined`), i.e. they escaped the structured error surface
entirely. `folders`/`websites` returned `null` typed as the record.

## F4 — reproduced BEFORE the fix

| Call | Observed before |
|---|---|
| `companies.resolve(undefined)` | `HuduConfigError` code=CONFIG_ERROR category=validation, message names accepted kinds |
| `users.resolve(undefined)` | `TypeError: Cannot read properties of undefined (reading 'id')` |
| `folders.resolve(undefined)` | `TypeError: Cannot read properties of undefined (reading 'id')` |
| `websites.resolve(undefined)` | `TypeError: Cannot read properties of undefined (reading 'id')` |

An audit of every resource exposing `resolve` (single live sweep, `resolve(undefined)`) found the same
raw-`TypeError` shape on five more: `groups`, `labels`, `labelTypes`, `lists`, `passwordFolders`.
All eleven are fixed; after the fix the sweep shows **zero** `TypeError`s (see after-table).

## Fix

Narrowest shared point for F2 — `src/resources/base.ts`:

- new `protected assertSingleFound<U>(record, operation, ids)`: a single-record read that unwrapped to
  `null`/`undefined` throws `NotFoundError` with `code NOT_FOUND`, `category not_found`, `status 404`,
  `operation` and `resourceIds` populated — the same shape a real `404` produces;
- `getOne()` (the shared `GET /{path}/{id}` + envelope-unwrap used by every resource `get`) now routes
  through it. This covers all five resources and every `resolve` that fetches by id.

Deliberately unchanged: a real `404` (already correct), and any non-`null` body — `{}` or
`{ folder: {} }` is a present-but-empty record, not a miss. `unwrapByKey` pass-through (envelope key
absent) is unchanged.

Identifier kinds accepted wording for `users.resolve` was hoisted into `ACCEPTED_USER_KINDS` so the
absent-identifier refusal and the no-stage-matched refusal name the same kinds.

F4 — one guard per resource's identifier normalizer, all throwing the shared `identifierError(...)`
(`HuduConfigError`, `code CONFIG_ERROR`, `category validation`, message names the accepted kinds and
says the SDK will not guess a kind the vendor cannot filter on), refused **before any HTTP request**:

| File | Normalizer | Guard added |
|---|---|---|
| `src/resources/users.ts` | `readUserIdentifier` | absent → `identifierError('users.resolve', ACCEPTED_USER_KINDS)` |
| `src/resources/folders.ts` | `folderLookup` | absent → `identifierError('folders.resolve', ACCEPTED_KINDS)` |
| `src/resources/websites.ts` | `websiteLookup` | absent → `identifierError('websites.resolve', ACCEPTED_KINDS)` |
| `src/resources/groups.ts` | `groupLookup` | absent → `identifierError('groups.resolve', ACCEPTED_KINDS)` |
| `src/resources/password_folders.ts` | `passwordFolderLookup` | absent → `identifierError('password_folders.resolve', ACCEPTED_KINDS)` |
| `src/resources/labels.ts` | `readLabelIdentifier` | absent → `identifierError('labels.resolve', ...)` |
| `src/resources/label_types.ts` | `readLabelTypeIdentifier` | absent → `identifierError('label_types.resolve', ...)` |
| `src/resources/lists.ts` | `readListIdentifier` | absent → `identifierError('lists.resolve', ...)` |

Only the ABSENT case was changed. The existing invalid-value refusals in `folders`/`websites`/`groups`/
`password_folders` (`ValidationFailedError`) are unchanged — existing tests assert that class, and
widening the class swap is out of scope for F4.

## AFTER — live-verified (same five resources)

Command: `npm run build && node /tmp/probe-after.mjs` (full output `/tmp/probe-after.txt`).

| Resource | `get(99999999)` after | real id (`get` / `resolve`) |
|---|---|---|
| articles | `NotFoundError code=NOT_FOUND category=not_found status=404 resourceIds=[99999999]` msg `articles.get: the vendor answered 200 with an empty body, so no articles record has this id.` | `get(16)` → record id=16; `resolve(16)` → record id=16 |
| assetLayouts | `NotFoundError code=NOT_FOUND category=not_found status=404 resourceIds=[99999999]` msg `asset_layouts.get: ...` | `get(1)` → record id=1; `resolve(1)` → record id=1 |
| assetPasswords | `NotFoundError code=NOT_FOUND category=not_found status=404 resourceIds=[99999999]` msg `asset_passwords.get: ...` | **UNVERIFIED** — the tenant holds 0 asset_password rows (`listAll()` = 0), so no real id exists to fetch |
| folders | `NotFoundError code=NOT_FOUND category=not_found status=404 resourceIds=[99999999]` msg `folders.get: ...` | `get(1)` → record id=1; `resolve(1)` → record id=1 |
| websites | `NotFoundError code=NOT_FOUND category=not_found status=404 resourceIds=[99999999]` msg `websites.get: ...` | `get(1)` → record id=1; `resolve(1)` → record id=1 |

`resolve(99999999)` and `resolve({id: 99999999})` now throw the same `NotFoundError` on all five
(they inherit the `get` path). No `TypeError` appears anywhere in the after sweep.

F4 after (live): `users`, `folders`, `websites`, `groups`, `labels`, `labelTypes`, `lists`,
`passwordFolders`, `companies` all answer `resolve(undefined)` and `resolve(null)` with
`HuduConfigError code=CONFIG_ERROR category=validation` naming the accepted kinds.

## Other single-record reads checked (F2, shared path)

| Read | Result |
|---|---|
| `companies.getContext(99999999)` | `NotFoundError code=NOT_FOUND status=404 resourceIds=[99999999]` (already correct, unchanged) |
| `assets.get(3, 99999999)` (company-scoped) | `NotFoundError code=NOT_FOUND status=404 resourceIds=[99999999]` (already correct) |
| `users.get`, `companies.get`, `lists.get`, `groups.get` on a missing id | `NotFoundError code=NOT_FOUND status=404 resourceIds=[...]` (already correct) |
| `companies.findBySlug('__nope__')` | RETURNED `null` — BY DESIGN: a helper-tier complete scan that found nothing, not a `get(id)` |
| `photos.get` / `publicPhotos.get` / download variants | **UNVERIFIED** live (no photo/uploads rows on the tenant to probe) |

## Tests

New file `test/live-id-miss-contract.test.ts` (41 tests, no network — `stubFetch`/`json` from
`test/helpers.ts`). For each of the five resources: `200` + `null` → `NotFoundError` with
`code NOT_FOUND`, `category not_found`, `status 404`, `resourceIds [99999999]`, never a `TypeError`;
`resolve(id)` / `resolve({id})` same; a real record unaffected; a real `404` unchanged; `{}` body not a
miss; `{"website": null}` envelope is a miss. For F4: `resolve(undefined)`/`resolve(null)` →
`HuduConfigError` with `code CONFIG_ERROR` and zero HTTP requests issued, across nine resources.

No existing test was weakened, skipped or edited.

## Gates (exact)

```
$ npx tsc --noEmit        -> no output (0 errors)
$ npm run lint            -> eslint src test, no output (0 problems)
$ npm test                -> Test Files 50 passed (50); Tests 1607 passed (1607)
$ node scripts/check-capabilities.mjs -> PASS — 0 failures; rows=225 scoped=225 registryRecords=225 warnings=66
$ node scripts/live-smoke.mjs         -> TOTAL 40  PASS 40  FAIL 0  SKIP 0
```

Live harness BEFORE the change: `TOTAL 40  PASS 40  FAIL 0  SKIP 0` (identical to AFTER — the harness
did not cover a `200`+`null` miss; that is exactly the gap this change closes).

`check-capabilities.mjs` warnings are pre-existing `unplanned-surface` notes for `websites.listAll` /
`websites.listPages`; this change adds no public surface (one new `protected` helper plus internal
guards).

## Safety / cleanup

No record was created, updated or deleted. Final list counts after all runs:
`companies=21, websites=2, articles=4, groups=1, users=1, lists=1, assetPasswords=0` — every
pre-existing record untouched. `activity_logs.deleteAll` and `magic_dash.delete` were never run (not
even dry-run). The API key appears in no file in the repo and not in this report.


## Concurrent working-tree edits (read this before attributing the gates)

This repo is being edited by sibling agents in the SAME working tree. When this task started,
`git status --short` showed only `.run/live/*`; during the run a sibling's resolution/truncation work
appeared in the tree (`src/resources/agent-layer-helpers.ts`, `articles.ts`, `asset_layouts.ts`,
`asset_passwords.ts`, `assets.ts`, `companies.ts` — `assertScanDecided`). Those files are NOT part of
this task's change.

- My edits: `src/resources/base.ts` (import + `assertSingleFound` + `getOne`), `users.ts`, `folders.ts`,
  `websites.ts`, `groups.ts`, `labels.ts`, `label_types.ts`, `lists.ts`, `password_folders.ts`,
  `test/live-id-miss-contract.test.ts`, this file.
- The gate results above ran on the shared tree, so they include the sibling's in-flight edits; all
  gates were 0/PASS at that moment. Every live result in this report was produced after
  `npm run build` on that same tree, so the live claims cover the sibling's code too.
- Nothing was committed or pushed.

## Residual gaps

- `assetPasswords`: miss path fixed and live-verified; positive control **UNVERIFIED** (tenant has zero
  asset_password rows).
- `get(undefined)` now reports `NOT_FOUND` (it previously reached the wire the same way). An id-less
  `get` would be better as `CONFIG_ERROR`; not changed here because it is outside F2/F4 and would alter
  an existing contract for 30+ resources.
- `photos.get` / `publicPhotos.get` / `uploads.get` null-body behaviour: **UNVERIFIED** live.
