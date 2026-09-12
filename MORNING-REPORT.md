# MORNING REPORT — node-hudu agent-execution-layer backfill

**Run:** `node-hudu-backfill-20260912` · **Branch:** `feat/agent-execution-layer` · **Baseline:** `main` @ `9332efe` (0.2.1) · **Target:** 0.3.0 (minor, additive)
**Written:** 2026-09-13T01:46:15.215873+10:00 · **Status of this file:** drafted mid-run; the Finalise step rewrites the TL;DR and the ledger.

## 1. TL;DR

1. **Done:** the whole retrofit is implemented, tested and gated. 225 plan rows (158 primitives + 67 helpers incl. 2 cross-resource) all reach `tested`; `capabilities:check --ship` PASSES; the full suite is green with coverage above the frozen thresholds; the package builds, packs and imports from ESM and CJS in a clean directory.
2. **In review right now:** the final five-lens QA pass (4 lenses running, the packaging lens waits on the MCP curation); one MCP-surface de-duplication is in flight.
3. **What to do first in the morning:** read §4 (QA) and §6 (autonomous decisions), then run `npm run typecheck && npm run lint && npm test && npm run capabilities:check -- --ship` on the branch head and open the PR (§8 has the literal command).

## 2. Commits (30 on the branch, none on `main`, nothing pushed)

- `a364ef7` — chore(run): record the MCP curation result and dispatch the tool-list de-duplication
- `9de0463` — chore(run): start the final five-lens pass and record the release re-verification
- `ca011f1` — chore(run): record the release artefacts and the packaging proof
- `2190248` — chore(release): 0.3.0 - version, changelog, README helpers section, architecture pointer, API appendix
- `e717ccc` — chore(run): start the mcp projection stage
- `684721b` — feat(operations): cross-resource helpers, and expose them on the client
- `cc7c6b9` — chore(run): record the four QA verdicts, the fixes and the accepted debt
- `f19b382` — fix(agent-layer): make the additive guard real, repair the registry graph and gate the manifest
- `9f6a9ec` — fix(registry): universal CONFIG_ERROR, STALE_OBJECT on the guarded updates, a non-dangling related graph and honest plan usage
- `a415d6b` — fix(plan): stop the id-only resolve helpers claiming resolution codes they cannot raise
- `acc2c59` — chore(run): record the cross-model safety findings and the fix dispatches
- `ed37986` — feat(plan): add the two cross-resource operation rows and fix the derive status report
- `fdeec90` — chore(run): record the tests stage and the qa launch decision
- `fab190a` — test(agent-layer): all 223 plan rows reach tested - ship gate passes
- `43d2520` — chore(run): record the four batch gates and the coordinator cleanup
- `edb8453` — fix(capabilities): derive drops through the overload union so every compact helper resolves
- `643ea08` — feat(agent-layer): implement the helper floor, safety classification and tests for all 35 resources
- `d047f3b` — chore(run): wake log - implementers in flight, shared files clean
- `8426881` — chore(run): protect the shared type barrel from concurrent writers
- `bf76af5` — chore(run): record the core-plumbing gate result
- `6fe3316` — feat(agent-layer): structured errors, correlation ids, audit hook, dry-run and bounded scan
- `1894750` — chore(run): start the four group implementation batches (7 parallel implementers)
- `137b264` — chore(run): record the tooling stage result and coverage finding
- `8e8b42c` — feat(capabilities): add the capability tooling, generated registry and manifest
- `be4ad4e` — docs(design): point group A compact shapes at the resource type files
- `9bf94c2` — docs(scoping): declare compact shapes in the resource type files; record the baseline surface capture
- `65d1da5` — test: capture the 0.2.1 public surface and assert the retrofit stays additive
- `fdab7e9` — feat(plan): design groups A-D - judgement columns, 65 helper rows, compact shapes, design docs
- `7401338` — feat(plan): fill group A judgement columns and add the 25 group A helper rows
- `6882fce` — chore: bootstrap agent-execution-layer retrofit (branch, scoping, plan derivation, run state)

## 3. Per group — status and gate results

| Group | Rows | Implement | Tests | QA | Fix |
|---|---|---|---|---|---|
| A (companies, articles, assets, asset_layouts, asset_passwords, websites, folders, password_folders, groups) | 77 | done | done | done | done |
| B (networks, vlans, vlan_zones, ip_addresses, rack_storages, rack_storage_items, relations, flags, flag_types) | 57 | done | done | done | done |
| C (procedures, procedure_tasks, cards, activity_logs, expirations, matchers, magic_dash, api_info) | 44 | done | done | done | done |
| D (uploads, photos, public_photos, exports, s3_exports, lists, label_types, labels, users) | 47 | done | done | done | done |
| operations (searchAcrossResources, resolveAny) | 2 | done | done | in the final pass | — |

Gate evidence, all on the branch: `npx tsc --noEmit` exit 0 · `npm run lint` exit 0 · `npm test -- --coverage` exit 0 with 99.65 lines / 99.89 functions / 92.49 branches / 99.27 statements (thresholds 97/94/83/97, unchanged since `main`) · `node scripts/check-capabilities.mjs` PASS 0 failures · `--group A|B|C|D|operations` PASS · `--ship` PASS · negative fixture exit 1 (by design) · `npm run build` emits 6 entries × 4 formats · `npm pack` + clean install imports ESM and CJS for root, `/capabilities`, `/operations`, `/resources`, `/errors`.

## 4. QA — findings raised, fixed, deferred

Four independent read-only lenses ran after the batch implementation, then a final pass over the whole branch.

| Lens | Findings | Fixed | Deferred / accepted |
|---|---|---|---|
| `qa-safety` (run cross-model on claude-sonnet) | 5 (1 CRITICAL, 2 HIGH, 1 LOW, 1 NIT) | 4 | 1 LOW accepted: the guard-refusal helper is duplicated in 17 resource files (no correctness bug; the variants emit different messages that tests assert; a 17-file refactor minutes before release was judged riskier than the debt) |
| `qa-agent-layer` | 14 (3 HIGH, 3 MEDIUM, 4 LOW, 4 NIT) | all HIGH + MEDIUM | LOW/NIT recorded |
| `qa-registry` | 15 (1 CRITICAL, 2 HIGH, 10 MEDIUM, 3 LOW, 1 NIT) | the CRITICAL, both HIGH, and the gate holes | cosmetic LOWs (example realism, two pagination shapes) |
| `qa-contract` | 9 (2 HIGH, 4 MEDIUM, 2 LOW, 1 NIT) | both HIGH | 1 pre-existing note (public_photos `singleKey` in ARCHITECTURE.md was already stale in 0.2.1 and is inert) |

The three findings worth reading about:

- **CRITICAL (safety, cross-model):** `exports.create` and `s3_exports.create` dry-runs claimed `impact.reversible: true` although the API has no cancel or delete path — a false safety claim no same-model reviewer or implementer test had caught. Fixed, and re-auditing found a **third** instance (`public_photos.create`). Every remaining `reversible: true` was then re-derived from the vendor spec.
- **CRITICAL (registry):** ~66 mutating records shipped examples containing `expectedUpdatedAt` on create/delete/archive, which the SDK now refuses — the registry's most-copied field documented calls that throw. Fixed in the generator, with a checker rule to keep it fixed.
- **HIGH (contract): the coordinator's own additive-only guard was vacuous.** The capture script never matched `export type * from`, so the star-barrel list was empty and deleting both type barrels left the test green — the entire types surface was unprotected. Fixed with `--ref` capture from the baseline, 113 type-barrel names in the fixture, and a meta-test that fails if the guard becomes vacuous again.

## 5. Blockers

_None that need a human decision._ Two operational notes:

- The safety guard blocked a recursive delete of a stray `coverage-ops/` directory (approval token `6659405459f4c527`). It was left in place and `coverage-*/` was gitignored instead; its owner deleted the other scratch artifacts.
- `tsconfig.json` excludes `test/`, so type errors inside test files are invisible to `npx tsc --noEmit` (pre-existing repo condition, flagged by two agents; the test files were type-checked out-of-band).

## 6. Autonomous decisions (each with its reversal)

| Decision | Why | Reversal |
|---|---|---|
| Coding model = `inherit` (the coordinator's model) | the handover makes the model the user's choice and left it unpinned; the user was asleep and "inherit" is an explicitly valid answer. Recorded because the QA pin is the SAME model, so I added a cross-model lens for the two highest-risk heads | set `codingModel` in `.run/RUN-STATE.json` and `SCOPING.md` §H to a selector from `await rlm.find_models(...)`, then re-dispatch the affected step |
| Three QA lenses run once over all four groups instead of three per group (12 spawns) | the four batches landed in one commit range within ~25 minutes and were no longer separable in time | spawn the per-group lenses from the gate entries in `.run/RUN-STATE.json` and the design docs in `.run/design/` |
| `staleCheck` is operation-shaped: `updated_at` only on the 20 guarded `<res>.update` rows, `unavailable` on every create/delete/archive/special | my first pass set it per resource, which made a create claim a stale guard it cannot have; three implementers independently hit the resulting false claims | edit the `staleCheck` cells in `capabilities.plan.json` and re-run `npm run plan:derive` |
| `expectedUpdatedAt` is REFUSED (HuduConfigError) rather than ignored on create/delete/archive | a silently ignored option claims a guard that never ran | remove `assertNoExpectedUpdatedAt` from `src/resources/base.ts` |
| Executed-mutation impact lives on the audit event (`AuditEvent.impact`), not on return values | primitive return shapes are frozen by the additive-only rule; the audit event is the SDK's result-metadata channel | delete the field from `AuditEvent` and from the two bulk pre-read paths |
| Compact summaries are declared next to their resource; the five the core layer had put in `types/common.ts` were removed | five reports of TS2308 duplicates; one writer per file while four implementers worked in parallel | move them back into `src/types/common.ts` and update the barrel |
| The registry's `errors` column lists what the SDK actually throws (`CONFIG_ERROR` everywhere, `STALE_OBJECT` on the guarded updates, no `RESOLUTION_*` on id-only helpers) | a registry that names codes the code never raises produces unwritable test rows | edit the rules in `scripts/derive-plan.mjs` |
| Plan test titles were reconciled to the titles the group-A tests actually carry (44 rows) | that implementer disambiguated repeated titles with an operation suffix; the tests exist and assert the right behaviour | restore the previous titles in `capabilities.plan.json` and rename the tests |
| The `qa-safety` LOW (17 duplicated guard-refusal helpers) accepted as debt | no correctness bug; variants emit different messages that tests assert | add the shared function to `src/resources/agent-layer-helpers.ts` and replace the remaining 11 local definitions |

## 7. Ledger

- spawns **19** · commits **30** · gate runs **40+** · QA findings **~43** · QA findings fixed **~38**
- wall clock: started 2026-09-12T23:07+10:00, still running at 01:46 (stopBy 2026-09-13T06:30:00+10:00)
- groups ran in parallel (7 implementers, ≤5 resources each) plus one tooling owner, one core-plumbing owner, one operations owner and one MCP toolsmith

## 8. Resume

```bash
cd /Users/maxs/gitrepos/node-hudu
cat .run/RUN-STATE.json            # first step that is not done
git log --oneline main..HEAD       # the commits that step claims
npm run typecheck && npm run lint && npm test && npm run capabilities:check -- --ship
cat .run/qa/qa-final-*.md          # the final lens verdicts
```

To open the PR once the final pass is closed: `gh pr create --base main --head feat/agent-execution-layer --title "feat: agent execution layer (0.3.0)" --body-file MORNING-REPORT.md`
