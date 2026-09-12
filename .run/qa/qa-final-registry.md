# FINAL REGISTRY reviewer — attempt 2 (node-hudu agent-execution-layer)

## Scope & pins
- Repo /Users/maxs/gitrepos/node-hudu, branch `feat/agent-execution-layer`.
- BRIEF pin was `ec9b7e1`; ACTUAL HEAD at review time = `98e25d8` ("chore(run): retire the silent
  registry lens and re-dispatch it with a tighter budget"). `git diff --stat ec9b7e1..HEAD` touches
  ONLY `.run/PROGRESS.log` and `.run/RUN-STATE.json`, so the ARTEFACT UNDER REVIEW IS IDENTICAL to
  the pinned commit `ec9b7e1`. Baseline `main` = `9332efe` (confirmed).
- Working tree is DIRTY (pre-existing, preserved, not mine): `M src/resources/activity_logs.ts`,
  `M src/resources/magic_dash.ts`, `M src/resources/procedures.ts`, `M test/resources/activity_logs.test.ts`.
  `scripts/check-capabilities.mjs` reads `src/resources/*.ts` for `coverage-source-missing`, so every
  checker run in this report (mine included) executes against the DIRTY tree, not against `ec9b7e1`.
  All checker runs below still PASS, so the dirty edits do not break the gate.
- Artefact hashes at review time: plan `e8b4ceb830aa4f688d4386535f32ea176e9b3f63edd4cc1b54fb84fd036f4a50`
  (agrees with `CAPABILITIES_PLAN_HASH` in src/capabilities.ts:37 and with the manifest header), 225
  plan rows, 225 registry records (158 primitive + 67 helper), manifest 147 tools.
- READ-ONLY. My only write is this file. Drift copies live in /tmp/qa-reg-final/ (outside the repo).

## Findings ranked

- **MEDIUM (worst finding of this lens) — 47 of the 66 MCP tools whose inputSchema advertises
  `expectedUpdatedAt` are NOT update operations, so the agent-facing MCP surface offers an input the
  SDK rejects with `CONFIG_ERROR`.** — `MCP_TOOL_MANIFEST.md` (`### hudu_create_flag`, `hudu_delete_*`,
  `hudu_create_procedure_from_template`, `hudu_duplicate_procedure`, `hudu_kickoff_procedure`,
  `hudu_update_ip_address`, `hudu_update_magic_dash_positions`, `hudu_update_matcher`,
  `hudu_update_rack_storage_item`, … 47 tools) sourced from `src/capabilities.ts`
  (`inputSchema.opts.fields` / `inputSchema.options.fields`). Evidence: parsed all 147 tool
  inputSchemas; 66 contain `expectedUpdatedAt`, only the 19 real `.update`-with-`staleCheck:
  updated_at` tools accept it (`src/resources/base.ts` assertNoExpectedUpdatedAt throws for every other
  primitive). The Toolsmith curation already strips duplicate fields through
  `MCP_TOOL_OVERRIDES.json` (`inputSchema.opts` on 82 tools), so the omission is curation drift, not a
  missing mechanism. Why it matters: the MCP tool schema is what an LLM client copies into a call; a
  wrong field there produces a validation error instead of a write, and the field is not marked
  anywhere in the schema. Fix: add an `inputSchema.opts` / `inputSchema.options` override for every
  non-update tool that removes `expectedUpdatedAt` (the same pass that removed `dryRun`), or emit it
  only for records whose plan row has `staleCheck: "updated_at"`.
- **MEDIUM — the gate's `errors-vocabulary` and `related-dangling` rules read the PLAN row, not the
  emitted record, so a defect introduced between plan and emission is ungated.** —
  `scripts/check-capabilities.mjs` (plan loop: `const related = row.metadata && ...; const rowErrors =
  Array.isArray(row.errors) ? row.errors : []`) vs `src/capabilities.ts` records. Evidence: I injected
  `"related":["bogus.op"]` into the RECORD of `companies.delete` in a /tmp copy of src/capabilities.ts
  and ran `--registry /tmp/...` → **exit 0, PASS**; I removed `CONFIG_ERROR` from the same RECORD's
  `errors` → **exit 0, PASS**. The same two mutations applied to the PLAN row → exit 1 with
  `related-dangling=1, errors-vocabulary=1`. So both rules exist and are reachable, but only through
  `capabilities.plan.json`; the record's own 356 `related` edges and 225 `errors` arrays are asserted
  by nothing. Mitigation measured: the emission IS currently faithful for those fields (see VERIFIED
  OK), so this is a gate-coverage gap, not a live defect. Fix: run those two rules against the emitted
  record too (the checker already parses `CAPABILITY_REGISTRY` with the TS compiler).

- **MEDIUM — 48 non-update records still advertise `expectedUpdatedAt` as an accepted input field
  with no warning, and passing it throws `CONFIG_ERROR` before the request is issued.** —
  `src/capabilities.ts` (`inputSchema.opts.fields[].name === "expectedUpdatedAt"` on 72 records; 48 of
  them are NOT `.update`-with-`staleCheck: updated_at`). Measured independently (JSON-parsed records) — and from the MCP side: 47 of the 66 MCP tools that advertise the field are non-update operations (see the finding above):
  `{"name":"expectedUpdatedAt","type":"string","required":false}` — no `description`, no
  `deprecated`, no marker, on records such as `activity_logs.deleteAll`. The CRITICAL's *example* half
  is closed (0 offending examples), and every record now lists `CONFIG_ERROR`, so the failure is
  discoverable — but the input schema is the field an agent reads, and it still offers the trap. Fix:
  drop the field from non-update records' `inputSchema` (the generator knows the primitive), or attach
  a `description` naming the guard.

- **LOW — `documentedMaxPageSize()` misses the `max: N` spelling, so `/procedures` is attributed to
  the policy default while the vendor documents a maximum of 1000.** — `scripts/generate-capabilities.mjs:587`
  (`/max(?:imum)?\s*(\d+)/i`) vs `api-docs.json` `/procedures` `page_size` = "The number of results to
  return per page (default: 25, max: 1000)." (the colon defeats `\s*`). Result: `groups.list`
  (`GET /groups`, "…(max 1000)") emits `maxPageSize: 1000, maxPageSizeSource: 'api-docs'`, while
  `procedures.list` (`GET /procedures`) emits `maxPageSize: 100, maxPageSizeSource: 'default'`.
  Not a lie — 100 is a client cap and is labelled `default` — but the source attribution is wrong for
  one of the two endpoints that document a maximum. Fix: `/max(?:imum)?\s*:?\s*(\d+)/i`.

- **LOW — the pagination comment still describes the superseded "leave it null" policy.** —
  `scripts/generate-capabilities.mjs:603-604` ("maxPageSize stays null: the vendor spec declares no
  enforced maximum, and a fabricated bound would be worse than an explicit null") while line 610-611
  emit `documentedMax ?? 100`. A reader of the generator is told the field is null; every paginated
  record now carries a number. Fix: update the comment.

- **LOW — the `compact: "…", drops: []` claim is unchanged on 4 records.** — `src/capabilities.ts`
  (`articles.getContext`, `assets.getContext`, `companies.getContext`, `operations.searchAcrossResources`
  — `outputSchema.drops: []`, `dropsUnresolved: false`) — `drops: []` means "the compact shape keeps
  every field", yet those shapes summarise members (`companies.getContext` → `CompanySummary`,
  `assets`/`articles`/`websites` arrays). Earlier LOW re-verified: STILL OPEN, and it grew by one
  record (`operations.searchAcrossResources`). `helper-compact-drops` accepts `drops: []` by design,
  so nothing gates it. Fix: state what the context shapes drop, or make the rule flag `drops: []`
  on a helper whose `outputSchema.fields` are all summary types.

- **LOW — `permissions` is still the literal "unknown" on all 225 records** — `src/capabilities.ts`
  (225/225). The rule (`record-permissions`) accepts "unknown", so this is a documented unknown rather
  than a defect; it stays open as informational only.

## Earlier findings re-verification (17 filed in .run/qa/qa-registry.md; siblings' items merged)

| # | Earlier finding | Verdict | Evidence |
|---|---|---|---|
| 1 | CRITICAL examples that throw (`expectedUpdatedAt` on non-update examples) | **CLOSED** | Independent JSON parse: 20 records carry it in `examples`, ALL 20 are `.update` + `staleCheck: updated_at`; **0** non-update offenders. Rule reachable: injecting it into a non-update example in a /tmp registry copy → exit 1, `example-expectedUpdatedAt=1` |
| 2 | HIGH stale `MCP_TOOL_MANIFEST.md`, nothing gates it | **CLOSED** | Header planHash == `CAPABILITIES_PLAN_HASH` == hash of `capabilities.plan.json`; header "registry records: 225" == parsed record count 225; `manifest-planhash` fires on both a /tmp copy with a zeroed planHash (exit 1) and one with `registry records: 999` (exit 1) |
| 3 | HIGH ship gate failed on the working tree | **CLOSED** | `node scripts/check-capabilities.mjs --ship` exit 0 on the current (dirty) tree; all 225 rows `tested` |
| 4 | MEDIUM `preferredWhen` rule structurally unreachable | **CLOSED** | Blanking `metadata.preferredWhen` on every row of a /tmp plan copy → exit 1, `preferredWhen-required=224, preferredWhen=224`. 0 plan rows lack it at HEAD |
| 5 | MEDIUM `errors` under-declared (no `STALE_OBJECT` etc.) | **PARTLY CLOSED** | `CONFIG_ERROR` on 225/225; `STALE_OBJECT` on all 20 `staleCheck: updated_at` rows; 12 codes total (was 11). Still absent: FORBIDDEN, CONFLICT, VALIDATION_FAILED, DUPLICATE_FOUND, METHOD_NOT_ALLOWED, SERVER_ERROR, TIMEOUT, `HTTP_<status>` |
| 6 | MEDIUM `compact` shape name never validated | **CLOSED** | `compact-shape-unknown` fires (bogus name in /tmp plan copy → exit 1). Independently: 35 distinct compact names, all exported from `src/types/**` or `src/operations/**`; 0 undeclared |
| 7 | MEDIUM a `client-scan` resolution with no cap passed | **CLOSED** | Stripping `maxScanRecords`/`maxScanPages` from a client-scan row in a /tmp plan copy → exit 1, `resolution-caps=1`. 0 plan resolutions with bad caps |
| 8 | MEDIUM no MAX bound anywhere (`maxPageSize: null`) | **CLOSED** | 23 page-mode records: 22 × `maxPageSize: 100`, 1 × `1000`; 0 paginated records with a null/non-positive max. Rule: nulling it in a /tmp registry copy → exit 1, `pagination=1` |
| 9 | MEDIUM emitted JSON Schema validates almost nothing | **NOT RE-VERIFIED** (out of budget) | see UNVERIFIED |
| 10 | MEDIUM 156 `inputSchema` fields omit `name` | **CLOSED** | Recursive independent walk: 0 field objects without a non-empty `name`. Rule reachable: deleting one `name` in a /tmp registry copy → exit 1, `inputSchema-name=1` |
| 11 | MEDIUM 79 dangling `related` edges | **CLOSED** | 356 edges, 0 dangling, 0 distinct dangling targets (independent JSON parse of the records; targets ⊆ record names) |
| 12 | MEDIUM ARCHITECTURE.md does not point at the capability matrix | **PARTLY CLOSED** | see VERIFIED OK / UNVERIFIED |
| 13 | MEDIUM `src/operations/` missing, exports not wired | **CLOSED** | `src/operations/` exists; `npm pack` + clean install imports `.`, `/capabilities`, `/operations`, `/resources`, `/errors` in ESM and CJS |
| 14 | LOW 66 `unplanned-surface` warnings unfalsifiable | **STILL OPEN (accepted)** | 66 warnings persist by design (warnings never fail); unchanged |
| 15 | LOW `capabilities.schema.json` not hash-pinned | **STILL OPEN** | the checker only tests existence (`emission-missing`) |
| 16 | LOW 3 `getContext` records claim `drops: []` while summarising | **STILL OPEN** | now 4 records (adds `operations.searchAcrossResources`); see Findings |
| 17 | NIT mutating tools expose the dry-run affordance twice | **CLOSED** | 0 records expose `inputSchema.dry_run`; the registry `opts.dryRun` entry is removed by override and the injected top-level `dry_run` is the single affordance |

## Drift battery re-run (my own three injections, on /tmp copies; each is a control-matched run)
| Injection | Command | Exit | Rule that fired |
|---|---|---|---|
| control — unmutated /tmp copy of the plan + matching /tmp manifest | `--plan /tmp/…/plan.clean-copy.json --manifest /tmp/…/manifest.clean.md` | **0** | none (proves the /tmp path itself does not fail) |
| `preferredWhen` blanked on all 225 rows | `--plan /tmp/…/plan.pw-blank.json --manifest /tmp/…/manifest.pw.md` | **1** | `preferredWhen-required=224`, `preferredWhen=224` |
| bogus compact shape `BogusCompactShapeXYZ` | `--plan /tmp/…/plan.compact-bogus.json --manifest …` | **1** | `compact-shape-unknown=1` |
| client-scan resolution with both caps stripped | `--plan /tmp/…/plan.res-caps-stripped.json --manifest …` | **1** | `resolution-caps=1` |
Note: `--plan` on a non-default path SKIPS `emission-planhash`, so each mutated plan was paired with a
/tmp manifest carrying that plan's own sha256 — otherwise every row would have failed for the wrong
reason. All three rules can be made to fail, so all three exist.

## Extra rule-reachability probes (registry/manifest side)
| Mutation (on /tmp copy) | Exit | Rule |
|---|---|---|
| `expectedUpdatedAt` added to a non-update RECORD example | 1 | `example-expectedUpdatedAt=1` |
| a field's `name` key deleted in a RECORD | 1 | `inputSchema-name=1` |
| `maxPageSize: null` on `groups.list` in a RECORD | 1 | `pagination=1` |
| manifest planHash zeroed | 1 | `manifest-planhash=1` |
| manifest "registry records: 999" | 1 | `manifest-planhash=1` |
| `related` dangling edge in a RECORD | **0** | none — rule is plan-only (see Finding 1) |
| `CONFIG_ERROR` removed from a RECORD's `errors` | **0** | none — rule is plan-only (see Finding 1) |

## Overrides & manifest audit (MCP_TOOL_OVERRIDES.json: 644 records, manifest 147 tools)

Method: parsed `MCP_TOOL_MANIFEST.md` (tool blocks + the three tables) and `MCP_TOOL_OVERRIDES.json`
independently, then cross-checked against the registry records. Script: `/tmp/qa-reg-final/audit3.py`, `audit4.py`.

| Requirement | Result | Evidence |
|---|---|---|
| every override record has `{tool, field, newValue, reason}` | **PASS** | 644/644 have exactly those 4 keys, non-empty `tool`/`field`/`reason`; 0 malformed |
| override field vocabulary | PASS | `name` 147, `title` 147, `description` 147, `inputSchema.opts` 82, `annotations.bounded` 62, `exclude` 56, `inputSchema.options` 3 = 644 |
| every override targets a tool that exists in the projection (or is excluded) | **PASS** | 0 override targets outside {projection ∪ 22 rule-excluded ∪ 56 curated-excluded ∪ the 147 pre-rename mechanical names the `name` overrides legitimately use}. All 147 `name` overrides' new names are projected; 0 overrides name a curated-excluded tool except the 56 `exclude` records themselves |
| an excluded tool is NOT projected and IS listed with its reason | **PASS** | 56 curated-excluded tools; 0 of them appear under `## Tools`; 0 rows lack a reason; 56 distinct `backingOperation`; no duplicate rows. 22 rule-excluded listed with reasons (`## Excluded operations`) |
| no two remaining read tools share a `backingOperation` | **PASS** | 62 read tools, 62 distinct `backingOperation` values, 0 collisions |
| every remaining read tool states a real bound (default 10-25, max 100) | **PASS** | 62/62 carry `annotations.bounded` with `default 25` and `maximum 100`; 0 without a bound; 0 with a placeholder |
| every remaining read tool is helper-tier backed | **PASS** | 62/62 `tier="helper"`; 0 `primitive-read` tools in the projection, 0 rows in "read tools still backed by a plain primitive" |
| every mutation states its dry-run affordance exactly once | **PASS** | 85/85 mutations: exactly one top-level `dry_run` input key, `dryRunAffordance="dry_run"`, the registry `opts.dryRun` duplicate removed by override (0 tools still expose it), and the description states `dry_run: true` once |
| sensitive / requiresApproval operations say so in their description | **PASS** | 13 projected `sensitive=true` tools (asset_passwords + password_folders) all contain "Sensitive:"; 27 projected `requiresApproval=true` tools all contain `requiresApproval:`; 0 registry `sensitive`/`requiresApproval` rows are projected without the annotation |
| tier mislabel (`getWithTasks`) closed | **PASS** | records now carry `kind`, and `isHelperRecord`/tier read `kind === 'helper'` before the `HELPER_TIER_METHODS` regex, so the 3 compact holders the regex misses (`operations.resolveAny`, `operations.searchAcrossResources`, `procedures.getWithTasks`) are still tiered `helper`: manifest tiers = 62 helper + 85 primitive-write, 0 mislabelled |

Only standard-contradicting item found: the 47 non-update tools advertising `expectedUpdatedAt`
(Findings, item 2). No other tool contradicts the standard.


## VERIFIED OK
- 225/225 registry records parsed independently from the emitted source; 158 primitive + 67 helper; plan rows and records correspond 1:1 (0 registry orphans, 0 plan rows without a record) — `python3 /tmp/qa-reg-final/audit.py`.
- 0 non-update examples carry `expectedUpdatedAt`; 356 `related` edges with 0 dangling targets; `CONFIG_ERROR` on 225/225; `STALE_OBJECT` on 20/20 guarded updates.
- `node scripts/check-capabilities.mjs` → PASS, 0 failures, rows=225, registryRecords=225, warnings=66; `--ship` → exit 0.
- `node scripts/check-capabilities.mjs --plan test/fixtures/capabilities.plan.drifted.json` → exit 1 (negative fixture honours `--plan`).
- Every gated plan column has a faithful emission: 0 mismatches on `errors`, `related`, `preferredWhen`, `compact`, `dryRun`, `resolution`, `effect`, `flags`, `usage`, `purpose` across all 225 pairs. The only plan/record divergences are by design or documented: `permissions` (plan null → record "unknown"), `kind`/`resource` (derived), `redaction` and `staleCheck` (plan columns NOT carried into the record — `CapabilityRecord` in src/capabilities.ts:17-36 does not declare either), `group`/`status` (plan-only).
- `maxPageSize` provenance: `groups.list` = 1000, `maxPageSizeSource: 'api-docs'`, verified against `api-docs.json` `/groups` → `page_size` "The number of results to return per page (max 1000)". 22 other page-mode records = 100 / `'default'`; all 23 `defaultPageSize: 25`. `page_size` maxima documented in api-docs.json: `/groups` (max 1000) and `/procedures` (default: 25, max: 1000); only `/groups` is picked up (see Finding 3).
- Manifest/overrides audit: 644/644 override records well-formed; 56 curated exclusions (0 projected, all with reasons, 56 distinct `backingOperation`); 62 read tools with 62 distinct `backingOperation` and 62/62 stating `default 25 / maximum 100`; 85 mutations with exactly one `dry_run` affordance; 13 sensitive + 27 requiresApproval tools all stating it — `python3 /tmp/qa-reg-final/audit3.py`.
- `inputSchema` schema-level duplicate removal verified: 0 of 94 `dryRun: true` records still expose a registry `dryRun` input on the tool; 0 tools have two dry-run affordances.
- Emission faithfulness: 0 mismatches on `errors`, `related`, `preferredWhen`, `compact`, `dryRun`, `resolution`, `effect`, `flags`, `usage`, `purpose` between plan and registry across all 225 pairs.
- 147 projected tools match the seeds: helper-tier 62, primitive-read 0, mutations 85; manifest header self-consistent.

## UNVERIFIED
- capabilities.schema.json's actual validation strength (earlier MEDIUM #9) — not re-read.
- ARCHITECTURE.md wording (earlier MEDIUM #12) — not re-read.
- `npm test -- --coverage`, `npx tsc --noEmit`, `npm pack` install matrix: taken from the seeds, not re-run by me.
- `src/operations/` runtime behaviour beyond its export surface.
- The dirty working-tree edits' own correctness (out of scope: they belong to another lens).
- I did not re-run `scripts/derive-plan.mjs` or `scripts/generate-capabilities.mjs` end to end, so I cannot
  claim the plan emits from the vendor spec without drift — I verified the EMITTED artefacts only. The
  `/procedures` max-page-size miss (Finding 3) is direct evidence that the generator is not fully
  spec-faithful, and I did not enumerate every other place a vendor maximum could hide (I checked every
  `page_size` description in api-docs.json: only `/groups` and `/procedures` document one).
- The 56 curated exclusions' OUTCOME-equivalence judgements (whether each dropped tool really duplicates
  the retained one) — I verified the mechanism and the one-tool-per-`backingOperation` invariant, not
  each curation decision's semantics.
- The 22 rule-excluded tools' reasons are consistent with rule 6 (binary resources); I did not test
  whether a non-binary resource could hide behind that rule.
- Whether MCP_TOOL_OVERRIDES.json's 147 renames are good names (naming standard) — not a registry claim.
