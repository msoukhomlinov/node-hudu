# impl-progressive-disclosure (build-order step 4) — REPORT

STATUS: DONE for the catalog and reachability (the point of the feature). The invoke validator is
implemented and tested in the consumer layer; its SDK-side twin (`operations.invoke`) was NOT added
(see §9) — parity with the typed path is UNVERIFIED.

## 1. What landed

| Piece | File | Kind |
| --- | --- | --- |
| CORE inclusion rule + the 3 META tool specs + profile-aware `--check-example` | `scripts/project-mcp-tools.mjs` | projection (one implementation of the curation rules) |
| Generated catalog + CORE list + runtime helpers (paging, describe, validation, write governor) | `scripts/build-tool-catalog.mjs` (new) -> `examples/tool-catalog.generated.ts` (generated, 105 KB) | generated consumer-layer artifact |
| 6 new gate rules | `scripts/check-capabilities.mjs` | gate |
| 15-tool CORE reference server (12 typed + 3 META) | `examples/mcp-server.ts` | regenerated |
| 21 tests (catalog reachability, CORE rule, G4 shape enumeration, write governor) | `test/mcp-tool-catalog.test.ts` (new) | test |
| New manifest section "Core profile (progressive disclosure)" | `MCP_TOOL_MANIFEST.md` | regenerated (`npm run mcp:project`) |

No file under `src/` was touched; the SDK stays MCP-independent (the generated module imports
NOTHING and the host passes the registry record in). No runtime dependency was added.

## 2. The CORE set, by rule

The rule is IMPLEMENTED in `scripts/project-mcp-tools.mjs` (`CORE_RULE`, `WORKFLOW_RESOURCES`,
`CORE_READ_PREFERENCE`) and reprinted into the manifest, so the projection can be read against it.
R1 discover / R2 tenant / R3 find / R4 one read entry per group-A workflow resource; writes are
never in core. Measured today: **15 tools** — 3 META + `hudu_search_across_resources`,
`hudu_resolve_any`, `hudu_get_api_info`, and one helper read per group-A resource
(`hudu_get_company_context`, `hudu_get_article_context`, `hudu_get_asset_context`,
`hudu_get_asset_layout`, `hudu_search_asset_passwords`, `hudu_search_websites`, `hudu_get_folder`,
`hudu_search_password_folders`, `hudu_search_groups`). Group-A coverage: **9/9**.

The design's 16th tool is `hudu_search_knowledge`: `operations.searchKnowledge` is not in the
registry yet (a later build step), so the rule records it as a gap and CORE grows to 16 by itself
when it lands (`coreProfile.gaps.discoveryOperationsMissing`).

## 3. META tools + the generated catalog

`hudu_catalog`, `hudu_describe`, `hudu_invoke` are registered by `examples/mcp-server.ts`; the
catalog rows, the CORE list and the META tool specs come from `examples/tool-catalog.generated.ts`,
generated from `capabilities.json` + the curated projection. Measured:

- 225 operations, **147 exposed as their own tool, 56 reachable only through `hudu_invoke`, 22 refused with a reason** — the 78 operations that no MCP client could reach before.
- refused rows carry `reachable: false` + the reason, and the bounded alternative when the registry has one; curated-out rows stay `reachable: true` with `tool: null`.
- `hudu_catalog` states the subset fact in its own description (gated), pages at 40 rows / hard cap 100, and reports `total_operations` / `unexposed_operations` / `unreachable_operations` on every call.

Correction to the design's breakdown (measured): the 22 rule-exclusions are **all binary/download
surfaces (22)**; the 10 `listAll`/`listPages` unbounded reads are NOT registry records (they exist
as public SDK methods and are reported by `capabilities:check` as unplanned surface), so no
unbounded row can appear in the catalog today. The rule that would refuse one is asserted in
`test/mcp-tool-catalog.test.ts` for any record that has one (currently vacuous for that half, and
stated as such).

## 4. `hudu_invoke` safety

- Validation against the registry record BEFORE any request: unknown top-level field, missing
  required field, wrong type, out-of-enum value -> `CONFIG_ERROR` with the field path, no request.
  Nested object fields are type/enum-checked; unknown NESTED keys are not refused (the vendor
  accepts extra keys, and refusing them would be stricter than the typed path this must mirror).
  Stated in the module, not implied.
- Unknown schema shape -> REFUSED (`auditSchemaVocabulary` gaps), never silently accepted.
- Write governor: a write without `dry_run: true` is refused; a destructive/approval-gated one also
  needs `confirm` == the operation key exactly; an operation in `REFUSALS` is refused outright
  (so the projection rule cannot be bypassed through the back door). This is a guard against
  accident, not a security boundary.
- Dispatch: the example resolves the SDK's OWN method (`companies.update` -> `hudu.companies.update`)
  and calls it positionally in the registry's declared field order, so there is no second write path.

## 5. Gate rules and the non-vacuity proofs

New rules in `scripts/check-capabilities.mjs`: `catalog-planhash`, `catalog-reachability`,
`catalog-op-exists`, `invoke-refusals`, `core-workflow-coverage`, `core-budget` (+ the generated
module's own invariant in `build-tool-catalog.mjs --check`). Each was proven non-vacuous by
injecting ONE violation into a /tmp copy of the generated module and showing exit 1 (the repo copy
was never modified):

| Injected violation | Result |
| --- | --- |
| delete the `websites.search` catalog row | `catalog-reachability` + `catalog-op-exists`, exit 1 |
| rename a row to `websites.bogus` | `catalog-op-exists` x2 + `catalog-reachability`, exit 1 |
| `CATALOG_PLAN_HASH = 'deadbeef'` | `catalog-planhash`, exit 1 |
| delete the `exports.get` refusal | `invoke-refusals`, exit 1 |
| replace a CORE entry with `hudu_not_a_tool` | `core-workflow-coverage` + `core-budget`, exit 1 |

## 6. Measured before/after (`tools/list`, cl100k_base, compact JSON)

| Surface | Tools | Bytes | Tokens |
| --- | --- | --- | --- |
| Today's flat curated surface (all 147) | 147 | 327,216 | 76,974 |
| CORE profile (12 typed + 3 META) | 15 | 29,800 (gate figure, wire fields only) / 30,168 (measured variant) | **6,976** |
| Reduction | -132 tools | **-90.9%** | **-90.9%** |
| 20-turn session, always-present surface | | | 1,539,480 -> **139,520** |

The design's 74,949-token figure is close but not identical (75k vs 76,974 today); the difference is
that the manifest was regenerated since, and the field set counted here is
`name/title/description/inputSchema/outputSchema/annotations`. Either number supports the same
conclusion: the flat surface is ~77k tokens, the CORE profile is ~7k. A catalog page is bounded by
the 100-row hard cap; `build-tool-catalog --check` and `core-budget` keep the profile from creeping
back (budget 32,000 bytes ≈ 8k tokens).

## 7. What breaks first, and what I changed to keep it honest

**`node scripts/project-mcp-tools.mjs --check-example` — as predicted.** The META tools are not
curated manifest tools, so the gate failed on three unknown tool names. Fix chosen (design §7.3.1
option (ii), because `MCP_TOOL_OVERRIDES.json` was outside my file ownership): the example declares
`const MCP_PROFILE = 'core';`, `--check-example` reads the declared profile (or `--profile <p>`) and
validates the registered set against the GENERATED CORE list, with META descriptions checked
verbatim against the projection. `core` requires the whole CORE set to be registered; `extended`
keeps the old subset behaviour. Two further honest notes:

1. The old `--check-example` path had an early `process.exit(0)`, so the profile/META checks would
   never have run; that early exit is removed (the manifest is simply not rewritten in check mode).
2. The design warned the example "20 -> 16 + 3 meta". The CORE list is generated, so the example
   now registers exactly the generated 15 (16 when `operations.searchKnowledge` lands).

## 8. Evidence (all from the repo root, branch `feat/agent-execution-layer`, nothing committed)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | 0 |
| `npm run lint` | 0 |
| `npm test` | 0 — 52 files, **1705 tests** (21 new) |
| `npm run test:coverage` | 0 — Stmts 99.31 / Branch 92.76 / Funcs 99.89 / Lines 99.66 (thresholds 97/83/94/97 — not lowered) |
| `npm run build` | 0 |
| `node scripts/check-capabilities.mjs` | PASS — 0 failures; rows=225; warnings=66 |
| `node scripts/check-capabilities.mjs --ship` | PASS — 0 failures |
| `node scripts/project-mcp-tools.mjs --check-example` | PASS — profile=core, 15 tools (12 read, 3 META) |
| `node scripts/build-tool-catalog.mjs --check` | PASS — 225 rows, 147 exposed, 56 invoke-only, 22 refused |
| 5 injected-violation fixtures | exit 1 each (table in §5) |

No test was weakened, skipped or deleted. No existing signature, return shape or error-code meaning
changed. No generated file was hand-edited (`MCP_TOOL_MANIFEST.md` and
`examples/tool-catalog.generated.ts` are generator output).

## 9. Plan overrides added, and what is partial / UNVERIFIED

**Plan overrides added: NONE.** `capabilities.plan.json` is byte-identical (no `planHash` change),
so `src/capabilities.ts`, `capabilities.json` and `capabilities.schema.json` are untouched. The
design's §7.3.1 option (i) wanted the three META tools recorded as `MCP_TOOL_OVERRIDES.json` records
with `kind: "meta"`; that file was not in my file ownership, so the META tools are owned by the
projection script and gated by `--check-example` verbatim instead. If the coordinator wants the
override-record form, it is the same three descriptions, moved.

UNVERIFIED / partial:

- **`operations.invoke` (SDK-side) was not added** — `src/**` was not mine. The validator, the write
  governor and the catalog therefore live in the generated consumer-layer module, and the example
  dispatches positionally to the typed SDK method. Consequence: **G5 (`invoke-parity`) is not
  implemented** (it needs one generated dispatch in the SDK to compare against). The validator's
  correctness is covered by the G4 shape-enumeration test instead.
- **Positional dispatch of the long tail is UNVERIFIED.** It is exercised for the CORE shapes by
  construction and by the registry's declared field order, but no operation outside CORE was
  invoked. Two shapes I would check first: an operation whose declared field order differs from its
  method's parameter order, and an operation whose only argument is an options bag.
- **No live sandbox run was made**, so no record was created, and no cleanup inventory is owed
  (nothing to delete). Articles 16-19 and the 20 account-wide assets were not touched.
- **Host behaviour is UNVERIFIED** (as in the design): per-session `tools/list` filtering,
  `notifications/tools/list_changed`, and whether any host re-fetches. The mechanism does not depend
  on it.
- The `core` profile is demonstrated by the reference server; `extended`/`all` are documented as
  host knobs but are not demonstrable without shipping 147 registrations.

## 10. Files touched

`scripts/project-mcp-tools.mjs` (rule, META specs, profile-aware gate, importable projection),
`scripts/build-tool-catalog.mjs` (new), `scripts/check-capabilities.mjs` (6 rules),
`examples/mcp-server.ts` (regenerated to CORE+META), `examples/tool-catalog.generated.ts`
(generated), `MCP_TOOL_MANIFEST.md` (regenerated), `test/mcp-tool-catalog.test.ts` (new),
`.run/live/impl-progressive-disclosure.md` (this report).
