# fix: operations.invoke call SHAPE (status: fix + tests DONE, gates running)

## The bug
`hudu.operations.invoke('cards.lookup', { integration_slug: 'acme' })` issued
`GET /api/v1/cards/lookup?0=a&1=c&2=m&3=e`. The dispatcher passed one positional argument per flat
registry field, so the method's single `params` object received the STRING `'acme'`, and the query
serialiser spread that string into one parameter per character. Right path, nonsense parameters,
no error — 66 uncurated operations were reachable in name only.

## The fix (`src/operations/invoke.ts`)
`invokeCallShape(record)` decides the shape from the record, and `planInvoke` builds the arguments:

| shape | when | arguments |
|---|---|---|
| `positional` | no fields; OR a field is an OBJECT (`data`/`params`/`opts`); OR one flat field; OR `exampleCallArity(record) === fields.length` | one argument per declared field, in order (unchanged) |
| `bag` | flat fields and the record's own example passes exactly ONE argument | ONE object built from the named fields (the `cards.lookup` case) |
| `unknown` | the record does not settle it | REFUSED with a `CONFIG_ERROR`; never guessed |

The signal for the one case structure cannot settle: the generator's `paramInfo()` FLATTENS a
single object parameter into top-level fields, so `cards.lookup` (one `params` bag) and
`assets.get(companyId, id)` (two parameters) both arrive as a flat field list. What survives is
`examples[0]`, rendered by that same `paramInfo()`, so its top-level argument count IS the parameter
count the schema lost. `Function.length` was rejected: default parameters and rest args make arity
lie. Independent verification: every one of the 36 `bag` rows declares a 1-parameter method in
`src/resources/*.ts`, and `assets.get` declares 2.

Second defect, found by the new registry-wide test: `inputFields()` skipped map keys literally named
`name`/`type`/`fields`, which DROPPED real fields on 18 records (17 × `name`: `companies.list`,
`articles.list`, …; 1 × `type`: `procedures.list`) and reduced `lists.findByName` to `[opts]` — so
`findByName(name, opts)` was dispatched as `findByName({ resolutionDetails: true })`, the same bug
class. A field node is always an object and the structural keys are a string or an array, so the
test is now on the value's shape. Regression coverage: the new registry-wide counts.

## Judgement column
NONE. `capabilities.plan.json` was not touched and no generated file was regenerated: a `callShape`
column would have to reach the record, and the emitted record's field list lives in
`scripts/generate-capabilities.mjs` (not mine to edit). The shape decision needs no authored input —
the record's structure plus its own generated example settle all 227 records, and the test fails if
any future record does not settle.

## New assertions (`test/operations/invoke.test.ts`, 44 tests, all green)
1. `exampleCallArity` unit tests (nested commas, empty call, no call).
2. EVERY record: `invokeCallShape` is never `unknown`, and `plan.args.length` equals the expected
   parameter count (1 for a bag, one per field otherwise); the example is never longer and never
   omits a required field; a bag example passes ONE object carrying every required field.
3. EVERY bag record (36): exactly ONE argument, it is an object, its keys are exactly the caller's
   keys, and every value equals the caller's value → no string can reach the query serialiser where
   an object belongs.
4. EVERY positional record: argument *i* deep-equals field *i* (the write's dry-run bag being the
   only augmented argument).
5. Fetch SPY per shape: `cards.lookup` → `?integration_slug=acme` and `searchParams.get('0')` is
   null (the reported leak); an omitted optional filter is absent; `assets.get` → path segments
   `/companies/7/assets/11` with no query; `companies.update` (dryRun:false) → PUT body carries the
   caller's data; `activity_logs.resolve` → the scan query carries `resource_type`/`resource_id`;
   the shipped `rack_storages.get` example still reaches `GET /rack_storages/42`.

## `*.list` decision: REFUSE
`companies.list()` returns an AsyncIterable; awaiting it yields the iterator, which JSON-serialises
to `{}` with zero requests. Refused, not materialised: the module's contract is request-scoped
("owes NO transport, NO pagination and NO scanning"), so collecting a stream would mean inventing a
bound and an unbounded scan — and the honest alternative already exists on the typed path. The
refusal names it (`hudu.<resource>.listAll({ ... })` when the resource has one) and is REQUEST-FREE,
because an async generator does no work until it is iterated (asserted: 0 fetch calls). There is no
`*.listAll` registry key, so pointing at one would have been a lie; the message points at the typed
method. Registry-wide: every `*.list` record that is not projection-refused rejects with a
`HuduConfigError` and `{}` is unreachable.

## Gates — ALL PASS
| gate | result |
|---|---|
| `npm run build` | 0 |
| `npx tsc --noEmit` | 0 |
| `npm run lint` | 0 |
| `npm test` | 0 — 1837 tests passed |
| `node scripts/check-capabilities.mjs` | PASS — 0 failures; rows=227 scoped=227 registryRecords=227 |
| `node scripts/check-capabilities.mjs --ship` | 0 (SHIP=0) |
| `MCP_PROFILE=core node scripts/project-mcp-tools.mjs --check-example` | 0 — `hudu_invoke` still dispatches through `operations.invoke` |
| `node scripts/build-tool-catalog.mjs --check` | PASS — 227 rows, 139 exposed, 66 reachable via `hudu_invoke` only, 22 refused |
| `npm run test:coverage` | 0 — 1838 tests; `invoke.ts` 94.4% stmts / 88.49% branch (thresholds unchanged and met) |

No generated file changed: `capabilities.plan.json`, `capabilities.json`, `src/capabilities.ts` and
`examples/tool-catalog.generated.ts` are byte-identical (the `--check` gates above prove it).

## Files touched
- `src/operations/invoke.ts`
- `test/operations/invoke.test.ts`

## Not mine, left alone
`.run/live/impl-search-engine-perf.json` is modified in the working tree and was so before this
task — no source file was reverted, no branch switched, nothing committed or pushed.

## Verification notes
- The 36 `bag` rows were cross-checked against the SDK source: each declares a 1-parameter method
  (`cards.lookup(params)`, `companies.list(params?)`, …) and `assets.get` declares 2 — the
  examples-derived classification agrees with the implementation for every row.
- A live sandbox call was not needed: `cards.lookup` cannot succeed on the tenant (no integration),
  and a fetch spy proves the URL shape, which is the whole contract under test.
