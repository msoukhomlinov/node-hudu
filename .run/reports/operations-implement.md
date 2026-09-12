# operations-implement — cross-resource helpers (`src/operations/`)

Stage: `operations` (api-node-squad 3.0.1 agent execution layer) · Repo `/Users/maxs/gitrepos/node-hudu` ·
Branch `feat/agent-execution-layer` · Agent `impl-operations` (sub-617dfdba).

## 1. Files

| File | State | What it is |
|------|-------|------------|
| `src/operations/types.ts` | NEW | Every public type: `SearchableSummaryMap` / `SearchableRecordMap` (the resource -> row maps), `SearchableResource`, `SearchHit`, `SearchHitMap`/`SearchHitUnion`, `SearchHitExpanded`(+Map/Union), `SearchAcrossResourcesOptions`, `ResolutionCandidateHit`(+Map/Union), `ResolveAnyOptions`, `ResolveAnyResult` |
| `src/operations/operations.ts` | NEW | `class Operations` with the two public methods; the fan-out tables, bounded fan-out, validation and reporting. Module basename is `operations` ON PURPOSE (see §4) |
| `src/operations/index.ts` | NEW | The `./operations` subpath barrel (class + types) |
| `test/operations.test.ts` | NEW | 22 tests, mocked fetch only |
| `package.json` | edit | `exports["./operations"]` = `./dist/operations/index.{d.ts,js,d.cts,cjs}` (mirrors `./resources` / `./capabilities` style) |
| `tsup.config.ts` | edit | entry `'src/operations/index.ts'` appended |

Nothing else was touched. No commit, no push.

## 2. Commands (exact) and exit codes

| Command | Exit |
|---------|------|
| `npx tsc --noEmit` | **0** |
| `npx eslint src/operations test/operations.test.ts` | **0** |
| `npx vitest run test/operations.test.ts` | **0** — 1 file, **22 tests passed**, 0 failed, 0 skipped |
| `npm run build` | **0** — emits `dist/operations/index.js`, `.cjs`, `.d.ts`, `.d.cts`; the emitted `index.d.ts` declares `Operations` and both methods |

Coverage of the new module (measured with `npx vitest run test/operations.test.ts --coverage --coverage.include='src/operations/**'`, no threshold change anywhere):
`src/operations/operations.ts` = **128/128 statements (100 %), 79/79 branches (100 %), 52/52 functions (100 %)**.
`types.ts` / `index.ts` contain no executable statements, so they add nothing to the global ratio — the new module does not dilute the frozen 97/94/83/97 thresholds.

## 3. Plan titles implemented (verbatim, asserted against `capabilities.plan.json` with the checker's own regex)

`operations.searchAcrossResources`:
- `returns hits from every searched resource` — `test/operations.test.ts`
- `searches only the resources asked for` — `test/operations.test.ts`
- `honours limit and never exceeds the maximum of 100` — `test/operations.test.ts`
- `bounds the fan-out to the configured concurrency` — `test/operations.test.ts`

`operations.resolveAny`:
- `resolves a domain to a company and a serial to an asset in one call`
- `returns candidates instead of throwing when several resources match`
- `returns an empty result after a complete bounded search`
- `rejects an unsupported resource name with CONFIG_ERROR`

All 8/8 title strings are present verbatim (no template literals in any title). Beyond the declared titles the file also covers: helper-tier-only fan-out (`listAll`/`list`/`listPages` spies never called), zero writes from both helpers (every request `GET`), `expand: true` full records for all eight resources, the `#<id>` label fallback, a repeated resource name searched once, empty query / empty resource list `CONFIG_ERROR`, per-resource truncated scans reported in `truncated`, `RESOLUTION_TRUNCATED` when every scan was truncated with no hit, `NOT_FOUND` for a definite id no resource holds, numeric-string and `{ id }` definite forms, a resource's own ambiguous candidate ids kept, and `CONFIG_ERROR` when a resource ignores `resolutionDetails`.

## 4. Contract decisions a reviewer will want (all documented in code)

1. **Module filename is `src/operations/operations.ts`.**
   `scripts/generate-capabilities.mjs` and `scripts/check-capabilities.mjs` resolve a helper row
   `operations.searchAcrossResources` by looking up the module key `operations` -> `src/operations/<basename>.ts`,
   and both **skip** `index.ts`/`base.ts`. A class in `src/operations/index.ts` would therefore raise
   `coverage-source-missing` / "no module … operations.ts". The class lives in `operations.ts`; `index.ts` stays
   the subpath barrel. `src/operations/search.ts` / `resolve.ts` were dropped for the same reason (a file
   basename `search`/`resolve` would not be reachable from a row name).
2. **A definite id that exists nowhere throws `NOT_FOUND`; a complete name/domain search returns an empty `hits` array.**
   Policy §6: an id is a definite reference, so a set-wide id miss is `NOT_FOUND` (code `NOT_FOUND`, the row's
   declared code) rather than a misleading empty list; the row's `errors` column lists `NOT_FOUND`, and no
   other path in these helpers can raise it. An indefinite identifier (name/slug/domain/serial) that matches
   nothing after complete scans returns `{ hits: [], truncated: [], scanned }` — that is the declared title
   "returns an empty result after a complete bounded search". When **every** scan was truncated and nothing
   matched, the answer is undecided and `RESOLUTION_TRUNCATED` is thrown (the row's other declared code);
   a truncated scan alongside at least one hit is reported in `truncated`, never thrown and never "not found".
   **Override point for the coordinator if a different split is wanted.**
3. **`truncated` is `SearchableResource[]`, not `string[]`** (the brief's `string[]` widened). Any `string[]`
   consumer still type-checks; the narrower type is assignable to the brief's shape.
4. **Registry-safe return types.** The registry derives `outputSchema.drops` from the helper's
   **implementation** signature. `searchAcrossResources` implements `Promise<SearchHit[] | SearchHitExpanded[]>`
   and `resolveAny` implements `Promise<ResolveAnyResult>`, so `pickFullMember` resolves a full member and
   `dropsUnresolved` stays **false** (the shipping `helper-compact-drops` rule passes). `SearchHit`,
   `SearchHitExpanded`, `ResolutionCandidateHit`, `ResolveAnyResult` are interfaces (resolvable by `propsOfNode`);
   a mapped-type-only `SearchHit` would have made `dropsUnresolved` true. Callers still get the discriminated
   union, because the *overloads* return `SearchHitUnion[]` / `SearchHitExpandedUnion[]`
   (verified: `hit.resource === 'companies'` narrows `hit.item` to `CompanySummary`).
   Cosmetic note: for `resolveAny`, `drops` is computed against the `ResolveAnyResult` envelope
   (`['hits','truncated','scanned']`) — harmless, passes the gate, but an override in
   `MCP_TOOL_OVERRIDES.json` is the only way to change the text.
5. **Bounded fan-out.** One worker-pool `boundedMap(items, client.config.concurrency, fn)` — at most
   `concurrency` (default 4) helper calls in flight, order preserved, no unbounded `Promise.all`. It mirrors
   `BaseResource.mapConcurrent`, which is `protected` and unreachable from a cross-resource module; the
   per-resource work stays inside each resource's own `search`/`resolve` (vendor filter, `boundedScan`,
   `helperLimit`), so no transport, scan or limit logic is duplicated. Limits and the 25/100 rule come from the
   shared `resources/agent-layer-helpers.ts` `helperLimit`.
6. **No `listAll` / list primitive is ever called**; the only methods used are `search` and `resolve` (both reads).
7. **Ambiguity inside one resource is a candidate set, not a failure.** A resource's `RESOLUTION_AMBIGUOUS`
   becomes one candidate per id in `resourceIds` with label `#<id>` and `item: null`; nothing is dropped and the
   call never throws across the set. `NETWORK_ERROR` / rate-limit / bad-request errors still propagate.

## 5. Gaps / for the coordinator

- **UNVERIFIED: the coordinator's `capabilities:build` / `capabilities:check --ship` runs** (not mine to run).
  Verified instead: module key resolves to `operations` and both methods are public with the return types above
  (parsed with the TypeScript compiler API the same way the generator does); all 8 titles match the checker regex;
  `src/operations/operations.ts` has 100 % statement/branch/function coverage.
- **UNVERIFIED: `MCP_TOOL_OVERRIDES.json` / `mcp:project` output** for the two tools. The registry example text is
  mechanically `await hudu.operations.<method>()`. There is **no `client.operations` property** — `src/client.ts`
  is not in my file ownership, so the public surface is `new Operations(hudu)` from `node-hudu/operations`.
  If the MCP projection should call these through the client, someone who owns `src/client.ts` must add
  `readonly operations: Operations` (and `src/index.ts` must re-export the type) — small, additive, not done here.
- **Two resource-file defects found (not touched, not mine):** `websites.search`, `groups.search` and
  `password_folders.search` declare the loose `search(query, opts?: HelperOptions)` form as their
  **implementation** signature instead of an overload, so `websites.search(q, { limit })` does **not** typecheck
  (only `{ expand: true }` is accepted as a second argument) although the runtime path is the documented compact
  one and their own tests call it that way. Worked around with one documented `CompactSearch` cast per affected
  resource (no behaviour change, no extra request, shape unchanged). The real fix is adding the missing overload
  signature in those three files — additive, and it makes three existing test calls type-check.
- **One uncommitted edit remains:** `src/operations/operations.ts` is modified in the worktree (the
  `SearchHitUnion` overloads landed after your last commit of my files; `types.ts`/`index.ts`/`package.json`/
  `tsup.config.ts` are already committed). Please pick it up before the ship gate. I did not commit.
- Scratch artifacts `src/__probe2.ts`, `src/__probe.ts`, `src/operations/__probe.ts`, `.ops-check.mjs` and
  `coverage-ops/` are **all deleted** (`ls` confirms absence; `git status --porcelain` shows only
  `M src/operations/operations.ts` and `?? test/operations.test.ts` for my files).
