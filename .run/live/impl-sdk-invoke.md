# SDK-side INVOKE (`operations.invoke`) — build-order step 3b (implementation report)

Status: **DONE for `src/**`**. Owner: impl agent. Scope actually touched:
`src/operations/invoke.ts` (new), `src/operations/operations.ts` (one additive method + one import),
`src/operations/index.ts` (additive exports), `test/operations/invoke.test.ts` (new).
NOTHING under `scripts/`, `examples/`, `capabilities.plan.json`, `capabilities.json`,
`src/capabilities.ts`, `MCP_TOOL_MANIFEST.md` or any other generated file was touched, and no
generator was run. Branch `feat/agent-execution-layer`; no commit, no push.

## 1. What was built

`operations.invoke(operation, input?, opts?)` on the existing `Operations` class, plus a standalone
`invokeOperation(client, operation, input, opts)` and `planInvoke(record, operation, input, opts)`
for callers (and tests) that have a client but no `Operations` instance.

Pipeline, in this order, each step asserting the previous one:

| Step | What it does | Failure |
|---|---|---|
| RESOLVE | exact key lookup in `CAPABILITY_REGISTRY` (`getCapability`) | `CONFIG_ERROR` naming the 5 nearest real keys |
| REFUSE | the projection's excluded class (binary/download surface: `exports`, `photos`, `public_photos`, `s3_exports`, `uploads` — 22 operations) | `CONFIG_ERROR` with the reason |
| VALIDATE | the caller's bag against that record's `inputSchema`, before any request | `CONFIG_ERROR` naming every offending field path |
| GOVERN | dry-run-first writes, exact-`confirm` destructive gate | `CONFIG_ERROR` (or the typed path's own errors) |
| DISPATCH | the SDK's OWN typed method, resolved mechanically and bound, called positionally in registry field order | the typed method's errors, verbatim |

It is **MCP-independent**: `src/operations/invoke.ts` imports only `../capabilities.js`,
`../errors.js` and a type-only `HuduClient`. No MCP import, no tool concept, no transport, no
retry, no pagination, no scan — dispatch calls the published typed method, so its guards are the
ones that run.

Public surface is additive only: the three new exports plus the `invoke` method. Every existing
helper and primitive stays callable.

## 2. The registry row this capability needs (coordinator: add after the other agent lands)

`node scripts/check-capabilities.mjs` currently prints, as a warning (never a failure):

```
! [unplanned-surface] src/operations/operations.ts → operations.invoke: public method appears in
  neither the plan nor the registry — unplanned surface
```

The exact row (shaped on the shipped `operations.searchAcrossResources` row; keys in the plan's own
order). `tests[].title` strings are verbatim titles in `test/operations/invoke.test.ts`, which is
what the coverage rules grep for:

```json
{
  "endpoint": null,
  "primitive": null,
  "specialOp": null,
  "vendorFilters": [],
  "search": null,
  "helper": "operations.invoke",
  "helperBasis": "composite",
  "helperRationale": "Makes every operation the SDK implements genuinely callable by its registry key, which is what the progressive-disclosure catalog promises: without it the curated-out operations are catalogued but unreachable. It adds schema validation against the registry record and a dry-run-first write governor, and it re-implements no transport, so the typed method's guards, retries and error vocabulary are the ones that run.",
  "effect": "write",
  "flags": [],
  "dryRun": true,
  "metadata": {
    "purpose": "Invoke any operation in the capability registry by its exact key, validated against that record before any request.",
    "usage": "Exact registry-key lookup (never a tool name, never fuzzy). The input bag is validated against the record's inputSchema first: unknown fields, missing required fields, wrong types and out-of-enum values refuse with the field path, and no request is issued. Writes are DRY-RUN-FIRST: omit dryRun (or pass true) and the SDK dry-run path runs with no request, returning a DryRunResult with simulated: true; only an explicit { dryRun: false } executes. A destructive or approval-gated operation also needs { confirm: '<operation>' }. The binary/download resources the projection refuses are refused here too, so the escape hatch cannot bypass the projection rule. The dry-run flag belongs to the call options, not the payload. The result is the typed method's own result, never an invoke-specific envelope.",
    "preferredWhen": "Preferred whenever an agent needs an operation the core tool set does not expose; check the catalog row's `requires` first, and describe the record when the schema matters.",
    "related": [
      "operations.resolveAny",
      "operations.searchAcrossResources",
      "operations.searchKnowledge"
    ]
  },
  "compact": null,
  "resolution": null,
  "staleCheck": null,
  "redaction": "none",
  "errors": ["CONFIG_ERROR", "NETWORK_ERROR", "NOT_FOUND", "POLICY_DENIED", "RATE_LIMIT", "RESOLUTION_TRUNCATED", "STALE_OBJECT", "UNAUTHORIZED", "UNPROCESSABLE_ENTITY"],
  "tests": [
    { "id": "operations.invoke.shape-coverage", "file": "test/operations/invoke.test.ts", "title": "every record is dispatched by a validator that understands every key and type it uses" },
    { "id": "operations.invoke.shape-enumeration", "file": "test/operations/invoke.test.ts", "title": "refuses a wrong-typed or out-of-enum value at EVERY declared field path" },
    { "id": "operations.invoke.shape-distinct", "file": "test/operations/invoke.test.ts", "title": "refuses every DISTINCT top-level shape, and accepts a valid bag for it" },
    { "id": "operations.invoke.unknown-shape", "file": "test/operations/invoke.test.ts", "title": "treats a shape it does not know as a REFUSAL, never an accept" },
    { "id": "operations.invoke.dispatch-reachability", "file": "test/operations/invoke.test.ts", "title": "resolves a callable typed method for every registry operation" },
    { "id": "operations.invoke.unknown-operation", "file": "test/operations/invoke.test.ts", "title": "refuses an unknown operation, naming the nearest real keys" },
    { "id": "operations.invoke.destructive-without-confirm", "file": "test/operations/invoke.test.ts", "title": "refuses a destructive operation without the confirmation flag" },
    { "id": "operations.invoke.argument-not-honoured", "file": "test/operations/invoke.test.ts", "title": "refuses an argument the operation cannot honour" },
    { "id": "operations.invoke.dry-run-default", "file": "test/operations/invoke.test.ts", "title": "write: dry-run FIRST by default — no request, and a DryRunResult says so" },
    { "id": "operations.invoke.client-scan", "file": "test/operations/invoke.test.ts", "title": "client-scan: a resolve with no vendor id endpoint goes through the bounded scan" },
    { "id": "operations.invoke.refusal-parity", "file": "test/operations/invoke.test.ts", "title": "refuses exactly the resources the projection refuses (no drift, no bypass)" }
  ],
  "group": "operations",
  "status": "tested"
}
```

Two judgement calls the coordinator should confirm:

1. `redaction: "none"` is deliberate. `invoke` performs NO redaction of its own — it dispatches to
   the typed method, whose own row carries the redaction claim. Claiming `credentials` here would
   assert a scrubbing the dispatcher does not do. (`operations.searchAcrossResources` — which also
   fans out over `asset_passwords` — is the shipped precedent for `none`.)
2. `staleCheck: null` for the same reason: the `expectedUpdatedAt` guard runs when the TARGET's row
   has one (`articles.update` etc.), and the option is a declared field of that target's `opts` bag,
   so it passes straight through. `null` matches the other three `operations.*` rows.

I did **not** invent any other public surface: no new tool name, no plan entry, no generated file.

## 3. Measured registry facts the validator had to handle (all from the shipped registry)

- 226 records; 36 resource prefixes; 226 distinct input schemas but only **49 distinct top-level
  shapes** and a handful of sub-shapes.
- Top-level inputSchema forms: `{}` (no arguments), a `fieldName -> field` map, and
  `{type:'object', fields:[...]}`. Field key vocabulary actually used: `name`, `type`, `required`,
  `fields`, `items`, `enum`, `anyOf`, `variants`, `typeName`, `additionalProperties`, `keyType`
  (+ `description` tolerated). Type vocabulary: `string`, `number`, `boolean`, `object`, `array`,
  `union`, `null`, `unknown`.
- Nested shapes: `object` with a declared field list (224+44 occurrences), `object` with
  `additionalProperties`/`keyType` (1 occurrence, `s3_exports.create.data`), `object` with NO
  declared fields (`items` of `{type:'object'}`), `array` of `object`/`number`/`string`,
  `union(number|string|object)` (35×), `union(object|object)` (4×), `union` with an enum (2×:
  `procedures.create` / `procedures.update` `data.process_type` = `union(string|string|null)` with
  `enum:["global","company","null"]`), enums on `string` fields (16×).
- **A real gap this work found and closed (worth a correction note):** a `union` can carry an
  `enum`. `checkValue` originally returned after the `anyOf` type test, so
  `data.process_type: 'anything'` was ACCEPTED for `procedures.create` / `procedures.update`. The
  shape-enumeration test caught it (2 failures, one per affected record); the union branch now
  enforces the enum. The host-side validator generated into `examples/tool-catalog.generated.ts`
  has the SAME early return — **`hudu_invoke` today accepts an out-of-enum `process_type` for those
  two operations**. That file is not mine; reported here for the other agent.
- Dispatch: the registry's `resource` prefix camel-cases to the client property for every one of
  the 36 prefixes, and `name` minus prefix is the method name; the registry's field ORDER is the
  method's positional order. All 226 resolve (asserted).
- Write governance: every one of the 94 non-read records has exactly ONE object field whose
  declared fields include `dryRun`, and it is the LAST top-level field — including the three
  quirky ones (`procedures.createFromTemplate`, `procedures.duplicate`, `procedures.kickoff`, whose
  bag is named `options` rather than `opts`). No write lacks a dry-run bag today; a synthetic
  record that does is refused (not executed) and covered by a test.

## 4. Enforcement, in the order it happens

1. **Unknown operation** → `CONFIG_ERROR` + the 5 nearest real keys; no request.
2. **Refused class** (22 binary/download operations) → `CONFIG_ERROR` naming the reason, mirroring
   the projection. Parity with the generated catalog's `REFUSALS` is TESTED (same set), so the two
   cannot drift and the escape hatch cannot bypass the rule.
3. **Argument the target cannot honour** → refused with the field path: unknown top-level field
   (including `dry_run` / `confirm` smuggled into the payload), missing required field, wrong type,
   out-of-enum value. Nested DECLARED fields are checked too (`data.draft`, `opts.expand`,
   `identifier.id`); undeclared keys inside an open record payload are allowed (the typed path's
   own tolerance) — the top level never is.
4. **Unclassifiable records** (`effect: null`) and **writes with no dry-run option** → refused, not
   executed.
5. **Writes** → dry run unless the caller passes an explicit `{dryRun: false}`. Default path issues
   NO request and returns the SDK's own `DryRunResult` (`simulated: true`). Proven by a test that
   asserts `spy.calls` is empty.
6. **Destructive / approval-gated** → refused unless `{confirm: '<exact operation key>'}`; the
   confirmation never substitutes for the dry-run opt-out (a confirmed delete with no
   `dryRun:false` is still only a dry run).
7. **Read + `dryRun: true`** → refused ("a read has no dry run").

## 5. Evidence / gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS (clean) |
| `npm test` | 1829 passed, **3 failed** — ALL 3 in `test/mcp-tool-catalog.test.ts` (see below), 0 in my files. My 30 new tests pass. |
| `node scripts/check-capabilities.mjs` | 1 failure: `core-budget` (CORE payload 38953 bytes > 32000) — the other agent's in-flight profile. My only footprint is the `unplanned-surface` warning for `operations.invoke` (the row in §2 closes it). |
| `node scripts/check-capabilities.mjs --ship` | same single `core-budget` failure; no `ship-status` failure from my files |
| `MCP_PROFILE=core node scripts/project-mcp-tools.mjs --check-example` | **PASS** (15 tools registered; META tools match; `hudu_invoke` uses the generated validator/governor) |
| `node scripts/build-tool-catalog.mjs --check` | **PASS** (226 rows; 139 exposed; 65 via `hudu_invoke` only; 22 refused with a reason) |
| `npm run build` (tsup, dual ESM+CJS) | PASS |
| Coverage thresholds 97/94/83/97 | NOT lowered. `npx vitest run --coverage.enabled=true` with the other agent's failing file excluded (a failed run writes no coverage report): total lines **99.11**, functions **99.46**, branches **90.93**, statements **97.84** — all above threshold. `src/operations/invoke.ts` itself: lines 98.37, functions 96.96, branches 86.7, statements 93.61. |

Pre-existing / not mine: the 3 failures in `test/mcp-tool-catalog.test.ts`
(`counts.exposed` 139 vs 148, CORE 38953 > 32000 bytes, `unexposed_operations` 65 vs 56) depend only
on `examples/tool-catalog.generated.ts` + `src/capabilities.ts` + the projection, all of which the
other agent is regenerating right now (the numbers moved between two runs of this session: 148 → 139
exposed). Not caused by, and not fixable from, my files.

## 6. Follow-ups for the coordinator (not done here, because the files are not mine)

1. Add the `operations.invoke` plan row (§2), then `npm run capabilities:build` + `npm run mcp:project`
   + `node scripts/build-tool-catalog.mjs` so the registry carries it.
2. `examples/mcp-server.ts` hand-rolls its OWN camelCase + positional dispatch for `hudu_invoke`
   (its comment at line 263 says so). That is a third resolution implementation: it should call
   `hudu.operations.invoke(operation, input, { dryRun, confirm })` so validation, governance and
   dispatch are one implementation — and so it inherits the union+enum fix in §3.
3. `examples/tool-catalog.generated.ts`'s generated validator has the same union-vs-enum early
   return (§3); worth fixing in `scripts/build-tool-catalog.mjs` while that file is being
   regenerated.
4. A destructive dry run currently still requires `confirm`. If the host prefers "confirm only when
   executing", that is a one-line change in `planInvoke`; the current rule is the stricter reading of
   "destructive operations are REFUSED unless the caller passes an explicit confirmation flag".
