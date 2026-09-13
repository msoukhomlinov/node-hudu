# INVOKE registration + one implementation, not two

Status: **DONE**. Branch `feat/agent-execution-layer`; no commit, no push, no branch switch. `npm run build`
after source edits. Report owner: registration/reference-server agent.

Files touched: `capabilities.plan.json` (hand-authored row -> regenerated everything downstream),
`examples/mcp-server.ts`, `examples/tool-catalog.generated.ts` (GENERATED),
`scripts/build-tool-catalog.mjs`, `scripts/project-mcp-tools.mjs`, `test/mcp-tool-catalog.test.ts`,
plus regenerated `capabilities.json`, `capabilities.schema.json`, `src/capabilities.ts`,
`MCP_TOOL_MANIFEST.md`.

---

## 1. The plan row added

`capabilities.plan.json` (append, index 226, after the three shipped `operations.*` rows). The row is the
specification from `.run/live/impl-sdk-invoke.md` §2, verbatim, with **one deliberate deviation**:

| field | spec said | shipped | why |
|---|---|---|---|
| `staleCheck` | `null` | `"unavailable"` | `scripts/check-capabilities.mjs:382` (rule `staleCheck`) requires a **mutation** (`effect:"write"` + `dryRun:true`) to carry a value or the literal `"unavailable"`. The spec's `null` fails the gate: `FAIL — 1 failure(s): staleCheck=1`. `"unavailable"` is the checker's own documented spelling and is honest — the dispatcher checks no timestamp of its own; `expectedUpdatedAt` passes through to a target row that has one. |

Everything else as specified: `helper: "operations.invoke"`, `helperBasis: "composite"`, `helperRationale`,
`effect: "write"`, `dryRun: true`, `redaction: "none"`, `compact: null`, `resolution: null`,
`group: "operations"`, `status: "tested"`, the 9-code `errors` list (CONFIG_ERROR + the codes the path really
raises), the full `metadata.purpose/usage/preferredWhen/related`, and the **11 test rows whose `title` strings
are verbatim `it(...)` titles in `test/operations/invoke.test.ts`** (machine-verified: all 11 present in that
file). The `preferredWhen` is required by rule `preferredWhen-required` because the `operations` resource has
helper rows; `related` names only real keys (rule `prose-dangling`).

Regenerated, in order: `npm run plan:derive` (227 rows, 69 authored helper rows preserved) ->
`npm run capabilities:build` (planHash `29c5b56e…`, 227 records emitted, `coverage gaps: none`) ->
`npm run mcp:project` -> `node scripts/build-tool-catalog.mjs`. Emitted record spot-check:
`examples: ["await hudu.operations.invoke('example', { dryRun: true })"]`, `permissions: "unknown"`,
`dryRun: true`, `staleCheck: "unavailable"`, `inputSchema {operation, input, opts{dryRun,confirm}}` — so
`record-examples` / `record-permissions` are satisfied by the generator, not by the plan row.

## 2. Checker state before / after

| | before | after |
|---|---|---|
| `node scripts/check-capabilities.mjs` | PASS, 0 failures, **warnings 67** | PASS, 0 failures, **warnings 66** |
| the `operations.invoke` warning | `! [unplanned-surface] src/operations/operations.ts → operations.invoke: public method appears in neither the plan nor the registry — unplanned surface` | **GONE** |
| `node scripts/check-capabilities.mjs --ship` | PASS, 0 failures, 67 warnings | PASS, 0 failures, 66 warnings |
| rows / registry records | 226 / 226 | **227 / 227** |
| projected tools | 139 | **139** (the row initially projected `hudu_operations_invoke`; curated OUT in the follow-up, §4.2) |
| catalog | 226 rows | **227 rows = 139 exposed + 66 reachable only through invoke + 22 refused** |
| CORE | 15 tools | **15 tools (unchanged)** |
| planHash agreement | — | manifest, `capabilities.json`, `src/capabilities.ts` and the catalog all carry `29c5b56e…` / the catalog carries `CATALOG_PLAN_HASH a0b59f71…` (its own wrapper hash over the same plan) |

The remaining 66 warnings are the pre-existing `listAll`/`listPages` unrouted-read warnings (65 of them) plus
one sibling of that class; none names `operations.invoke`.

**Side effect (RESOLVED in the follow-up, §4.2):** the new row is *projectable*, so the curated (extended)
surface briefly included one extra tool, `hudu_operations_invoke` — the SDK-level twin of the META tool `hudu_invoke`. The
two are not the same kind of surface (META is always present, the curated tool is only in `extended`/`all`,
which is never shipped whole; CORE is unchanged at 15), and the checker has no rule against it, so I left it
projected and moved the one pinned count in `test/mcp-tool-catalog.test.ts` from 139 to 140 with a comment
naming the new tool. If curation would rather not ship a duplicate, one `exclude` line for that tool in
`MCP_TOOL_OVERRIDES.json` restores 139/66 and that is a coordinator call, not mine.

## 3. Task 2 — ONE implementation, not two

### 3.1 The example now calls the SDK

`examples/mcp-server.ts`, `hudu_invoke` handler:

```ts
const opts: { dryRun?: boolean; confirm?: string } = {};
if (dry_run !== undefined) opts.dryRun = dry_run;
if (confirm !== undefined) opts.confirm = confirm;
const result = await hudu.operations.invoke(operation, (input ?? {}) as Record<string, unknown>, opts);
```

Removed: the hand-rolled `resolveMethod` (camelCase property + positional dispatch) and the whole three-step
"get record -> `validateInvokeInput` -> `governInvoke` -> dispatch" pipeline. The tool input field `dry_run`
changed from `z.boolean().default(false)` to `z.boolean().optional()`: omission now means *the SDK's own
default*, which is dry-run-first on a write and no dry run at all on a read — otherwise the example would have
had to keep a second rule ("writes without `dry_run: true` are refused") on the server side. Its description
was rewritten to match, **and the projected META description in `scripts/project-mcp-tools.mjs` was rewritten
identically**, because `--check-example` compares the two verbatim.

### 3.2 The generated validator: RETIRED (it was pure duplication), with its tests

Retired from the generated artifact by removing the emission from `scripts/build-tool-catalog.mjs`
(NEVER hand-edited the generated file): `auditSchemaVocabulary`, `typeNameOf`, `matchesType`, `checkValue`,
`validateInvokeInput`, `governInvoke` — the whole second copy of the registry schema language plus the second
write governor. `examples/tool-catalog.generated.ts` (131,160 -> 122,438 bytes) keeps the catalog **data**
(`CATALOG`, `EXPOSED`, `REFUSALS`, `CORE_TOOLS`, `META_TOOLS`, `TOOL_DESCRIPTIONS`, `SEARCH_*`) and the
readers/format helpers `catalogRow`, `nearestKeys`, `catalogPage`, `requireCatalogRow`, `describeOperation`,
`inputFields`, `configError`. Those read data; they do not decide whether a call is allowed.

Why retire instead of keeping it as a pre-check (the option the brief offered):

1. **It was already two edit sites for one language, and both had the same bug.** The union-carries-an-enum
   early return existed in both copies; the SDK's was fixed under test, the generated one was patched by hand
   in the generated file. That is exactly the failure mode the brief names.
2. **The two governors already disagreed.** Generated: `o.dry_run !== true` -> refuse every write. SDK:
   `{ dryRun: false }` -> execute. Two answers to "is this write allowed" is one answer too many; after the
   rewire nothing on any execution path called the generated one.
3. **Its replacement is better tested, not worse.** The surviving implementation is walked over every registry
   record and every declared field path by `test/operations/invoke.test.ts` (the G4 test, 30 tests); the
   retired copy was exercised by ~6 fixtures. Keeping a pre-check that no gate enumerates would have been a
   second, unpinned decider — the risk, not a mitigation.
4. **Nothing else consumed it.** Only `examples/mcp-server.ts` and `test/mcp-tool-catalog.test.ts` imported it.

What still guards the generated artifact: `check-capabilities.mjs` keeps its `catalog-planhash`,
`catalog-reachability`, `catalog-op-exists`, `invoke-refusals`, `core-workflow-coverage` and `core-budget`
rules on the generated module, and `--check-example` now fails if a second validator/governor reappears in the
handler:

```js
if (!/operations\.invoke\s*\(/.test(handlerCode)) failures.push('hudu_invoke: the handler never calls the SDK dispatcher operations.invoke …');
if (/validateInvokeInput\s*\(|governInvoke\s*\(/.test(handlerCode)) failures.push('hudu_invoke: the handler calls a SECOND validator/governor …');
```

That rule is a **tightening**: the old rule ("the handler calls the generated validator") could be satisfied by
a validator that disagreed with the SDK; the new one requires the SDK path and rejects a second decider.

### 3.3 Tests: the removed ones moved to a tested implementation, not into a gap

`test/mcp-tool-catalog.test.ts`: removed the 5 describes whose subject no longer exists (the generated G4
shape test, the 4 write-governor tests, the union-enum test) — 14 tests — together with the now-unused
`sampleValue` / `validInputFor` helpers and 4 imports. **Kept**: reachability, CORE-by-rule, catalog paging /
describe / `requireCatalogRow`, `configError`, the planHash pin. One pinned count moved 139 -> 140 (§2). The
file header now states where the equivalent assertions live and why they were removed *with* their subject
rather than left as a second untested path. The assertions themselves are not lost — each has a stronger
counterpart in `test/operations/invoke.test.ts`, which runs the same enumeration against the surviving
implementation:

| removed (generated copy) | living equivalent (SDK, G4) |
|---|---|
| handles every type and key the registry uses | `every record is dispatched by a validator that understands every key and type it uses` |
| every distinct shape is accepted with a valid bag | `refuses every DISTINCT top-level shape, and accepts a valid bag for it` |
| unknown field / missing required / wrong type / out-of-enum | `refuses a wrong-typed or out-of-enum value at EVERY declared field path` |
| unknown schema shape is a refusal | `treats a shape it does not know as a REFUSAL, never an accept` |
| write without a dry run refused (loop over every write) | `write: dry-run FIRST by default — no request, and a DryRunResult says so` + `refuses a destructive operation without the confirmation flag` |
| every refused resource is refused through the escape hatch | `refuses exactly the resources the projection refuses (no drift, no bypass)` |
| union that carries an enum must enforce it | same title, and it is the test that caught the bug |

Coverage cannot move from this deletion: `vitest.config.ts` sets `include: ['src/**/*.ts']`, so
`examples/**` is not measured at all; thresholds stay 97/94/83/97, untouched.

**There is now exactly ONE place that decides whether a call is allowed: `src/operations/invoke.ts`
(`planInvoke`, surfaced as `operations.invoke`).** The reference server calls it; the generated catalog
carries data; the gate rejects a second decider in the handler.

## 4. Gates (all run after the last edit)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (clean) |
| `npm run lint` | PASS (clean) |
| `npm run build` (tsup, dual ESM+CJS) | PASS |
| `npm test` | **58 files / 1824 tests, all pass** (0 failures; 14 generated-validator tests removed with their subject, 1 pinned count updated 139 -> 140) |
| `node scripts/check-capabilities.mjs` | PASS — 0 failures; rows=227 scoped=227 registryRecords=227 warnings=66 |
| `node scripts/check-capabilities.mjs --ship` | PASS — 0 failures; 66 warnings; no `ship-status` failure |
| `MCP_PROFILE=core node scripts/project-mcp-tools.mjs --check-example` | OK — 15 registered (12 read, 3 META), manifest projects 140, "hudu_invoke dispatches through the SDK operations.invoke — the single validator and governor" |
| `node scripts/build-tool-catalog.mjs --check` | PASS — current; 227 rows, 139 exposed, 66 via invoke only, 22 refused |
| CORE 32,000-byte budget | PASS (core-budget rule and the CORE test; CORE is still the same 15 tools, META description slightly longer) |
| coverage thresholds 97/94/83/97 | NOT lowered, not touched |

### 4.1 Test-run noise (not my edit)

`.run/live/impl-search-engine-perf.json` is rewritten by the search perf test on every `npm test` (timings
only, 3 lines). It shows as modified; it carries no source change from this work.

### 4.2 Follow-up gate results (after the exclude + the authored example)

| Gate | Result |
|---|---|
| `node scripts/check-capabilities.mjs` | PASS — 0 failures; rows=227 scoped=227 registryRecords=227 **warnings=66** |
| `node scripts/check-capabilities.mjs --ship` | PASS — 0 failures; 66 warnings |
| `npm run mcp:project` | **tools projected=139**; excluded=22; overrides applied=667; curation exclusions=66 |
| `MCP_PROFILE=core node scripts/project-mcp-tools.mjs --check-example` | OK — 15 registered; manifest projects 139 |
| `node scripts/build-tool-catalog.mjs --check` | PASS — 227 rows, **139 exposed, 66 via invoke only, 22 refused** |
| `npx tsc --noEmit` / `npm run lint` / `npm run build` | PASS / PASS / PASS |
| `npm test` | **58 files / 1824 tests, all pass** |

## 5. Open items for the coordinator

1. DONE (§4.2) — the projected twin was curated out.
2. DONE (§4.2) — the row authors a real example, now pinned by a test. Still open for OTHER rows: the
   generator's synthesised examples use the raw resource key (`await hudu.rack_storages.list({...})`, a
   property the client does not expose as written) and a sampled `'example'` key where a registry key is
   required; both are wrong every time they are generated, and only `metadata.example` fixes a row today.
3. **Invoke defect found while choosing the example** (not fixed, not mine): a single-object-bag method is
   dispatched POSITIONALLY, so `operations.invoke('cards.lookup', { integration_slug: 'acme' })` issues
   `GET /api/v1/cards/lookup?0=a&1=c&2=m&3=e`. The G4 test asserts every operation resolves; it does not
   assert arity/positional correctness. Separately, `*.list` invocations (and the direct
   `client.companies.list({...})` call) return `{}` with zero requests in this build — pre-existing, not
   invoke-specific.
4. A destructive operation still needs `confirm` even for its dry run (`planInvoke`). If the host prefers
   "confirm only when executing", that is a one-line change in `src/operations/invoke.ts` — the example's
   description and the projection would have to change with it.
