# Fix: magic_dash `company_id` is a GET-only filter (advertised as writable)

STATUS: DONE

## Defect
`magic_dash.create` (POST /magic_dash) advertised `company_id` as a write field in the exported type,
in the registry `inputSchema` and in the generated MCP tool. `company_id` is a GET-only filter.

## Live evidence (tenant intellectitdev, Hudu 2.45.1, 2026-09-12)
Command: `node /tmp/md-company-id-probe.mjs` (dist build of this branch, HUDU_BASE_URL/HUDU_API_KEY env).
Probe: list rows -> create with `company_id` -> create with `company_name` -> `deleteById` -> list rows.

### Before the fix
```
rows before: []
COMPANY_ID CREATE: ServerError | ServerError | Internal Server Error
company used: Microsoft Corporation
COMPANY_NAME CREATE: OK id=7 company_id=3 company_name=Microsoft Corporation
deleted id=7
rows after: []
```
`{ title: 'ZZ probe', message: 'x', company_id: 13 }` -> HTTP 500 SERVER_ERROR (opaque to an agent).

### After the fix (same probe, rebuilt dist)
```
rows before: []
COMPANY_ID CREATE: HuduConfigError | HuduConfigError | magic_dash.create: `company_id` is a GET-only filter, so this operation cannot honour it - sent in a write payload the vendor fails with HTTP 500. Pass `company_name` instead.
company used: Microsoft Corporation
COMPANY_NAME CREATE: OK id=8 company_id=3 company_name=Microsoft Corporation
deleted id=8
rows after: []
```
No request is issued on the refused path (asserted in the new unit test: fetch spy call count 0).

## Fixes
1. Runtime refusal (the part that protects callers)
   - `src/resources/agent-layer-helpers.ts`: new `refuseQueryOnlyWriteField(operation, payload, field, acceptedField)`
     throws `HuduConfigError` (CONFIG_ERROR) naming the operation, the field and the accepted
     alternative - same shape as `refuseDryRunInPayload`/`refuseExpectedUpdatedAtOutsideUpdate`.
   - `src/resources/magic_dash.ts`: called first in `create()`, before any request.
     There is no `magic_dash.update` method: POST /magic_dash is the one payload-taking write path
     (the plan's `preferredWhen` text pointing at `magic_dash.update` names an operation that does
     not exist - NOT fixed here, reported as an observation).
   - NOT refused on the read path: `magic_dash.list`/`listAll`/`resolve` keep `company_id`.
   - NOT refused on `magic_dash.updatePositions`, whose documented body legitimately takes `company_id`.
2. Truthful agent-facing schema
   - `src/types/magic_dash.ts`: `company_id` KEPT in `MagicDashCreate`/`MagicDashUpdate` (removing an
     exported field is a non-additive change to the public surface). Both types now document it in
     JSDoc as read-only on a write, rejected with CONFIG_ERROR before any request, use `company_name`.
   - `capabilities.plan.json`: `magic_dash.create` row gains `"inputSchemaOmit": ["company_id"]`.
   - `scripts/generate-capabilities.mjs`: `fieldAllowed(row, field)` honours `row.inputSchemaOmit`, so
     the derived (not hand-edited) schema drops the field: `magic_dash.create.data.fields` is now
     title, message, shade, content_link, content, icon, image_url, company_name, position.
   - `scripts/derive-plan.mjs`: `inputSchemaOmit` added to the preserved authored columns, so
     `npm run plan:derive` cannot silently regress the schema.
   - `scripts/check-capabilities.mjs`: rule `inputSchema-conditional-field` extended - the emitted
     record must not advertise a field its plan row omits.
   - Regenerated (never hand-edited): `src/capabilities.ts`, `capabilities.json`,
     `capabilities.schema.json`, `MCP_TOOL_MANIFEST.md`
     (planHash cdc6add3c12789b793cddc98c5d110eeb9544f101477bfa858a6b4789805057a).
3. Tests (additive; no existing test weakened, skipped or deleted)
   - `test/resources/magic_dash.test.ts`: new describe 'MagicDashResource - company_id is a GET-only
     filter' with 3 tests: refusal + zero requests; `company_name` still accepted; read path unchanged.
   - No existing test encoded the old (broken) behaviour.

## Gates (all pass)
- `npx tsc --noEmit` -> TSC=0
- `npm run lint` -> LINT=0
- `npm test` -> 51 files / 1684 tests passed, 0 failed
- `node scripts/check-capabilities.mjs` -> PASS - 0 failures; rows=225 scoped=225 registryRecords=225
- `node scripts/project-mcp-tools.mjs --check-example` -> PASS: tools checked=147; violations=0
- `npm run build` -> ok (dist rebuilt for the live probe)

## Tenant state
`magic_dash` rows: 0 before the probe, 0 after (`rows before: []` / `rows after: []`).
Probe rows created: id=7 and id=8 (both `ZZ probe`, company Microsoft Corporation), both deleted with
`magicDash.deleteById(id)`; the probe asserts the row list is empty afterwards.
