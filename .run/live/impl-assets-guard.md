# impl-assets-guard — live-verified defect fix (assets company-scoped companyId)

Status: DONE. Implementation + tests + typecheck + lint + full test suite all clean.

## Defect
`assets` is the only company-scoped resource in this SDK, and its methods interpolate `companyId`
straight into the request path. A missing/undefined/malformed id produced a request to a literal
`undefined` segment:

    GET https://<tenant>/api/v1/companies/undefined/assets?page=1&page_size=25  -> 500 ServerError

## Fix
ONE new module-level validator in `src/resources/assets.ts`, reused by every guarded entry point
(no copy-paste of the check):

```ts
function requireCompanyId(companyId: number | undefined, method: string): number {
  if (typeof companyId !== 'number' || !Number.isInteger(companyId) || companyId < 1) {
    throw new HuduConfigError(`${method} requires a positive integer companyId, got "${String(companyId)}"`);
  }
  return companyId;
}
```

Exact guard message format: `<operation> requires a positive integer companyId, got "<value>"`
The repro case: `assets.listAll requires a positive integer companyId, got "undefined"`
Error contract: `HuduConfigError`, `code: 'CONFIG_ERROR'`, `category: 'validation'`.

The guard runs BEFORE any IO: before a path is built, before a dry-run result is built, and before a
paging iterator is handed back. No HTTP request is issued.

## Guarded entry points (all in src/resources/assets.ts)
Path-bearing — the validated id is used to build the path:
- `get` -> `assets.get`; `create` -> `assets.create`; `update` -> `assets.update`;
  `delete` -> `assets.delete`; `moveLayout` -> `assets.moveLayout`;
  `setArchivedScoped` (private, serves both) -> `assets.archive` / `assets.unarchive`.

Streaming — throws at call time, before the iterator exists:
- `list` -> `assets.list`; `listAll` -> `assets.listAll`; `listPages` -> `assets.listPages`.

Helper tier and companyId forwarding:
- `resolve` -> `assets.resolve`
- `getContext` -> `assets.getContext`
- `listAllAcrossCompanies` -> `assets.listAllAcrossCompanies`

Semantics for the three forwarding entry points (documented in the code): the PRESENCE of the key is
what counts. An explicitly supplied `companyId: undefined` (or a malformed value) is a caller bug and
throws; the key OMITTED keeps the existing account-wide behaviour
(`resolve({ id })`, `listAllAcrossCompanies({})` unchanged, and both are asserted by tests).
A valid id behaves exactly as before: same path, same signature, same return shape, same error codes.

## Files touched
- `src/resources/assets.ts` — 1 validator + 12 guard call sites.
- `test/resources/assets.test.ts` — new `describe('AssetsResource — company id guard ...')`:
  - 13 entry points x 5 malformed values (undefined / NaN / 0 / -1 / 2.5): asserts `HuduConfigError`,
    `code === 'CONFIG_ERROR'`, the exact message, and `expect(spy.calls).toHaveLength(0)` (zero fetch calls).
  - 13 valid-id cases: asserts the normal request path (`/companies/13/assets...`,
    `/api/v1/assets?...company_id=13`) and that no `/companies/undefined` URL is ever produced.
  - the exact live-repro message for `assets.listAll(undefined)` plus zero fetch calls.
  - an account-wide no-regression case (`listAllAcrossCompanies({})`, `resolve({ id })`).
- `.run/live/impl-assets-guard.md` — this report.

No existing test was edited, weakened, skipped or deleted. No existing test encoded the old behaviour.

## Command results (repo root)
- `npx tsc --noEmit` -> exit code 0
- `npm run lint` -> exit code 0
- `npm test` -> exit code 0 (49 files, 1554 tests passed; baseline before this change: 1526)
- `npx vitest run --coverage` -> exit code 0; `src/resources/assets.ts`:
  stmts 100 / branch 92.85 / funcs 100 / lines 100 — all thresholds kept (97/94/83/97), none lowered.

## UNVERIFIED
- Live sandbox re-run of the repro (build + real Hudu tenant) was NOT re-executed from this worker.
  The fix is proven by the unit tests with a fetch spy (zero calls on invalid id, normal path on a valid
  id); the live `assets.listAll(13)` path is unchanged by construction.
- `assets.search` / `listAcrossCompanies` / `listAcrossCompaniesPages` were deliberately NOT guarded:
  they filter by `company_id` in the QUERY (no path segment is built), so they cannot produce the
  `undefined` path segment this defect is about. Marked as a known scope boundary, not a gap in the
  named requirement.
