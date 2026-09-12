# node-hudu backfill — handover note

**Prepared:** 2026-09-12 · **Skill:** `api-node-squad` 3.0.1 · **Target:** `node-hudu` 0.2.1 → 0.3.0 (minor)
**Purpose:** fully align this SDK with the agent execution layer (helper tier, capability registry,
mutation safety, structured errors) — additively — then QA the result with sub-agents.

| Decision | Value |
|----------|-------|
| **Scope** | **Full alignment — all 35 resources.** No bounded pilot (user decision, 2026-09-12) |
| **Primary coding model** | **Whatever model the user selects at run time.** Do not pin one here; record the choice in `SCOPING.md` Section H. Every implementation spawn either passes that selector or omits `model=` to inherit the coordinator's. Chosen **once at preflight** and held for the whole run — do not switch models mid-run (a switch can evict and reload a single-instance provider and change the code's voice halfway through a group) |
| **QA model** | `openrouter/deepseek/deepseek-v4.1-flash` at thinking **`xhigh`** — pinned for QA only (§9) |
| **Mode** | **Unattended overnight** (§10): heartbeat-driven, one step per wake, no questions, no polling, stops and reports at `stopBy` (default 06:30) |
| **MCP example** | Keep `examples/mcp-server.ts` in scope: regenerate it from the curated manifest in Phase 2 and commit it |

---

## 0. Read order

| Order | File | Why |
|-------|------|-----|
| 1 | `~/.prime/agent/skills/api-node-squad/references/agent-execution-layer.md` | **The policy.** The coordinator and the Architect read it end to end. §4.2 and §11 are **normative** (the capability gate and the required test rows) |
| 2 | `~/.prime/agent/skills/api-node-squad/references/accommodation-runbook.md` | §2.1 **H** (agent-readiness score) and **Phase F** (the additive retrofit, F.1–F.6) — this is the path we are on |
| 3 | `~/.prime/agent/skills/api-node-squad/references/execution-playbook.md` | Pre-flight, per-stage gates, pitfalls |
| 4 | this repo's `ARCHITECTURE.md` | Existing truth: envelope/capability table (line 753), pagination (§7), error hierarchy (§10), resource reference (§12) |
| 5 | **§10 of this note** | The unattended execution contract: the heartbeat driver, `RUN-STATE.json`, the step ladder, failure policy, safety rails, and the morning report. Read it before starting an overnight run |

The squad's own spawn prompts, gates and pitfalls are in `SKILL.md`; the per-stage detail is in the
playbook. Do not re-derive them from memory.

---

## 1. Objective and scope

**Deliverable:** `node-hudu` becomes a **deterministic execution layer for agents** while staying a
conventional, fully-typed SDK:

1. **Helper tier** per resource: `resolve(identifier)` everywhere; `findBy<Field>()` where the vendor
   exposes a usable filter; `search(query, { limit })` where text search exists; `getContext(id)` for the
   workflow resources. Cross-resource helpers land in `src/operations/`.
2. **Capability plan → registry:** `capabilities.plan.json` (authored) → `src/capabilities.ts`
   (generated) → `capabilities.json` + `capabilities.schema.json` (emitted at the repo root).
3. **Mutation safety:** `effect` + `sensitive`/`idempotent`/`requiresApproval` on every operation;
   `{ dryRun: true }` on every mutation, which never issues the write; impact statements; correlation ids.
4. **Structured error contract** on the existing hierarchy: `code`, `category`, `operation`, `retryable`,
   `httpStatus`, `vendorError`, `resourceIds`, `suggestedAction`, `correlationId`.
5. **Compact shapes** for the helpers, with an `expand` escape hatch.
6. **MCP tool manifest projected from the registry** (`MCP_TOOL_MANIFEST.md`), helper-tier backed.

**Explicitly not in scope:** changing any existing primitive's signature or return shape, changing an
existing error code's meaning, adding runtime dependencies, or rebuilding the SDK from the spec. This is a
retrofit: **additive only, minor bump.**

---

## 2. Verified repo facts (measured 2026-09-12)

| Fact | Value |
|------|-------|
| Repo / branch | `/Users/maxs/gitrepos/node-hudu` · `main` @ `9332efe` |
| MCP example | `examples/mcp-server.ts` — 318 lines, present at `HEAD`, **restored to that state on 2026-09-12** (the working tree had it emptied; that emptying was dropped). It is already MCP v2-aligned: official v2 SDK, zod v4, `structuredContent` + `outputSchema`, search-first tool names (`hudu_search_*`), bounded pagination, `HuduError.code` surfaced. **Phase 2's job is to re-back it with the helper tier and project it from the registry — not to rewrite it from scratch** |
| Spec | `api-docs.json`, Swagger **2.0**, `info.version` 1.0, aligned to **Hudu API 2.45.1** |
| Spec size | **82 paths · 158 operations · 35 definitions** |
| Source | `src/`: `client.ts`, `http.ts`, `auth.ts`, `config.ts`, `pagination.ts`, `errors.ts`, `logger.ts`, `utils.ts`, `index.ts`; `src/resources/` **35 resource files** + `base.ts` + `index.ts`; `src/types/` **40 files** |
| Operations today | **164 async methods** — incl. 32 `listAll`, 28 `get`, 27 `create`, 26 `delete`, 25 `update`, plus `archive`/`unarchive`/`jump`/`duplicate`/`lookup` |
| Helper tier today | **None.** Zero `resolve` / `findBy*` / `getContext` |
| Agent artifacts today | **None.** No `SCOPING.md`, `capabilities.plan.json`, `src/capabilities.ts`, `MCP_TOOL_MANIFEST.md` |
| Base class | `src/resources/base.ts` — `BaseResource<T>` carries `http`, `resourcePath`, `singleKey`, `listKey`, `createType`, `paginated`, plus `unwrapSingle`/`unwrapList`/`request`/`getOne`/`createOne`/`updateOne`/`deleteOne`/`setArchived`. **New agent-layer plumbing belongs here** (dry-run, classification defaults), not copy-pasted into 35 files |
| Envelope table | `ARCHITECTURE.md` line 753 — singleKey / listKey / createType / paginated / delete, per resource |
| Non-paginated list endpoints | `/ip_addresses`, `/lists`, `/networks`, `/procedure_tasks`, `/rack_storage_items`, `/rack_storages`, `/vlan_zones`, `/vlans` (+ `/exports`, `/api_info`, and the jump/lookup endpoints handled separately). These must **never** receive `page`/`page_size` |
| Envelope traps | `exports` and `s3_exports` have **void** creates; `public_photos` create/update is multipart; `assets` are company-scoped (`companies/{companyId}/assets`); `archive`/`unarchive` return void; **PUT update always unwraps by `singleKey`**, never by `createType` |
| Tests | `vitest`; 6 `test/resources/*.test.ts` + 9 top-level; fixtures in `test/__fixtures__/` |
| Coverage thresholds (current, in `vitest.config.ts`) | lines **97** · functions **94** · branches **83** · statements **97** — already above the squad's 90-line gate. **Keep them; never lower them to pass** |
| `package.json` | version `0.2.1`; `exports`: `.`, `./resources`, `./types`, `./errors`, `./package.json` |
| `tsup.config.ts` | 4 entries (`src/index.ts`, `src/resources/index.ts`, `src/types/index.ts`, `src/errors.ts`), dual ESM+CJS, dts |
| Dependencies | **none at runtime**; devDeps include `zod` and `@modelcontextprotocol/server` (MCP example only — keep them out of `src/`) |
| Logging | `src/logger.ts` already redacts credentials before logging — extend it for the audit hook rather than inventing a second redactor |

---

## 3. Non-negotiables

1. **Keep the MCP example.** `examples/mcp-server.ts` was restored from `HEAD` on 2026-09-12 and must stay
   present. Before committing anything, confirm it is not empty (`wc -l`); if it is, `git checkout --
   examples/mcp-server.ts`. Never commit the empty file, and never delete the example silently.
2. **Additive only.** No existing signature, return shape, or error-code meaning changes. Ship 0.3.0.
   Add a public-surface snapshot test so this is provable, not asserted.
3. **The plan is the source.** Never hand-edit `src/capabilities.ts`, `capabilities.json` or
   `capabilities.schema.json`; edit `capabilities.plan.json` and regenerate.
4. **Dry-run never writes.** Any dry-run path that issues the mutating request is a correctness defect,
   not a style issue.
5. **`resolve` never lies.** Return `null` only after a *complete* scan; throw `RESOLUTION_TRUNCATED`
   when the cap stops the search, and `RESOLUTION_AMBIGUOUS` with candidate ids when the filter is inexact.
6. **No unbounded scans, no unbounded `Promise.all`.**
7. **Keep the coverage thresholds** and the existing tests green at every batch.

---

## 4. Pre-flight (coordinator, ~30–45 minutes)

```bash
cd /Users/maxs/gitrepos/node-hudu
git status                                      # the only dirty file should be examples/mcp-server.ts
wc -l examples/mcp-server.ts                    # guard: the example must be 318 lines, never 0
git checkout -- examples/mcp-server.ts          # (only if the guard fails) restore the example
git switch -c feat/agent-execution-layer        # never work on main for this
cp -r . /tmp/node-hudu-backup-$(date +%Y%m%d-%H%M%S)   # cheap rollback (exclude node_modules if you prefer)
```

1. **Choose the coding model.** The primary coding model is **the user's choice** — this note pins nothing.
   Ask which model the implementation roles should use, enumerate the options with
   `await rlm.find_models("<provider-or-name>")` and use the returned `selector` **verbatim**; "inherit the
   coordinator's model" is a valid answer. Record it in `SCOPING.md` Section H so every spawn is consistent.
2. **Score the SDK** with `accommodation-runbook.md` §2.1 A–H. Expect a healthy A–G and **H = 1–3**
   (helper tier and metadata absent).
3. **Write `SCOPING.md`** at the repo root (skeleton in §14.1). This is a retrofit, so Section J's J3 is
   "existing SDK → retrofit". **There is no bounded pilot** — record the waiver explicitly
   (`"pilot": false, "pilotWaivedBy": "user decision 2026-09-12"`), because the runbook's Phase F gate
   otherwise expects one. The machine-readable JSON block at the end is what the rest of the run reads.
4. **Add the four scripts and npm scripts** (§14.2). `derive-plan.mjs` is the new mechanical step:
   spec + existing tree → `capabilities.plan.json`, idempotent, preserving judgement columns on re-run,
   and starting existing endpoints at `status: "implemented"`.
5. **Derive the plan:** `npm run plan:derive`. Sanity-check that all 158 operations have a row, that
   `group` is populated, and that the 35 resources' rows carry `status: "implemented"`.

6. **Bootstrap the unattended run** (§14.6): create `.run/`, write `RUN-STATE.json` from the ladder in
   §10.4 with `stopBy` set to your real deadline, start `PROGRESS.log`, then create the single heartbeat
   (§10.2) with `delivery_mode="follow_up"`. Commit `.run/` so the state survives a crash.

**Gate:** `SCOPING.md` confirmed (including the model choice and the no-pilot waiver);
`capabilities.plan.json` exists with every endpoint represented; `.run/RUN-STATE.json` exists with a
`stopBy`; exactly one heartbeat is scheduled and `rlm_heartbeat.list()` shows no second one.

From here the run is **unattended** (§10): stop giving it turns by hand, and let each wake advance one step.

---

## 5. Phase 1 — full sweep (all 35 resources, in groups)

**No bounded pilot.** The user's decision is full alignment in one run, so the runbook's F.6 pilot is
**waived** and recorded as such in `SCOPING.md`. What replaces it as the early-failure signal:

- the **per-group batch gate** (a group cannot be closed while its helpers, dry-run, classification or
  plan rows are incomplete),
- **per-group QA** (§10.4, `<g>.qa` then `<g>.fix`) — each group is reviewed and repaired before the next
  one starts, so a wrong helper shape is caught at Group A rather than copied 34 times, and
- **full closure per group**: design → implement → tests → qa → fix, then the next group. In unattended
  mode this ordering is what keeps 3 a.m. failures small and actionable (see §10).

### Suggested grouping

Adjust to taste; 6–9 resources per group, grouped by domain not alphabet:

| Group | Resources |
|-------|-----------|
| **A — primary nouns** | `companies`, `articles`, `assets`, `asset_layouts`, `asset_passwords`, `websites`, `folders`, `password_folders`, `groups` |
| **B — infrastructure & config** | `networks`, `vlans`, `vlan_zones`, `ip_addresses`, `rack_storages`, `rack_storage_items`, `relations`, `flags`, `flag_types` |
| **C — operations & workflow** | `procedures`, `procedure_tasks`, `cards`, `activity_logs`, `expirations`, `matchers`, `magic_dash`, `api_info` |
| **D — attachments, exports, rest** | `uploads`, `photos`, `public_photos`, `exports`, `s3_exports`, `lists`, `label_types`, `labels`, `users` |

All 35 resources are covered — every group is in scope, and the sweep is finished only when every group has
closed its batch gate.

### Per batch, in order

1. **Fill that group's judgement columns** in `capabilities.plan.json` — the same work described in §6,
   per resource. Above ~40 endpoints (this spec has 158 operations) the Design work is **per group**, and
   the Design gate applies to that group before its batch starts.
2. Implement the base-class plumbing plus that group's helpers, safety classification, dry-run and tests.
   **New cross-cutting behaviour goes in `src/resources/base.ts` or `src/client.ts`** — never copy-pasted
   into 35 files.
3. `npx tsc --noEmit` → `npm run capabilities:build` → `npm run capabilities:check -- --group <group>`.
4. Promote that group's rows to `implemented`. (`tested` comes later, from the Tests stage.)
5. Fix before starting the next group. **Cap any single spawn at ~8 resources** — the provider timeout is
   30 minutes with 3 retries, so a stuck request burns ~90 minutes.

Then run the Tests stage across the whole swept surface, followed by `npm run capabilities:check` (no
flag) as the pre-Review sanity pass.

**Gate (batch):** every planned helper for the group exists and is not a thin alias; no helper exceeds the
cap without a rationale; every mutation accepts `dryRun` and the dry-run path issues no write;
classification complete; the group's rows are `implemented`; `capabilities:check -- --group <group>` passes.

### Cross-resource helpers (after the per-resource sweep)

Add the helpers that span resources in `src/operations/` — for example
`searchAcrossResources(query, { resources, limit })` and `getAccountContext(companyId)`. They get their own
plan rows with `endpoint: null`, `group: "operations"`, and they are the last thing to implement before the
MCP projection, since the manifest's most useful tools usually back onto them.

---

## 6. Per-resource checklist (worked for `companies`, applied to all 35)

This is the recurring unit of work. `companies` is filled in as the reference; every other resource gets the
same nine answers, scaled to what its vendor API actually supports.

| # | Work | Concrete output |
|---|------|-----------------|
| 1 | Fill the resource's plan rows | `helper`, `helperBasis`, `helperRationale`, `flags`, `metadata` (purpose/usage/`preferredWhen`/related), `compact`, `resolution`, `staleCheck`, `redaction` — every column, explicit `null`/`"none"`/`"unavailable"` where nothing applies |
| 2 | Helpers on the resource class | `resolve(identifier)` **always**; `findBy<Field>()` where the API filters on that field and callers look up by it; `search(query, { limit })` where text search exists; `getContext(id)` only for the approved workflow resources |
| 3 | Lookup strategy | Server filter first. Where no filter exists (Hudu exposes no domain filter on `companies`), a **bounded client scan**: `resolution: { basis: "client-scan", maxScanRecords: 500, maxScanPages: 4 }`, exact match only, `resolutionCost` + `scanTruncated` reported, `RESOLUTION_TRUNCATED` thrown at the cap, `RESOLUTION_AMBIGUOUS` with candidate ids for an inexact filter |
| 4 | Compact shape | e.g. `CompanySummary` (+ the fields it drops, recorded in the registry `outputSchema`); helpers return it by default; `expand: true` returns the full record; **primitives keep returning the full record** |
| 5 | Safety | `effect`: `read` for get/list/helpers, `write` for create/update, `destructive` for delete; `sensitive` on credential-bearing resources (`asset_passwords`, `password_folders`), `requiresApproval` on destructive ops; `{ dryRun: true }` on create/update/delete/archive/unarchive returning `DryRunResult<T>` with `simulated: true`, never issuing the write |
| 6 | Errors | The resource's operation codes in the registry (`NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `STALE_OBJECT`, `RATE_LIMITED`, `RESOLUTION_TRUNCATED`, `RESOLUTION_AMBIGUOUS` as applicable), with the structured fields populated on the existing hierarchy |
| 7 | Stale check | `staleCheck: "updated_at"` where the API exposes a version field, otherwise the literal `"unavailable"` — an answer either way |
| 8 | Tests | The normative §11 rows for this resource: dry-run issues no mutating request (spy on the transport), resolve unique/miss/truncated, scan cap respected, ambiguity path, compact-shape field loss, correlation id on the success **and** error paths, audit/redaction, every documented error code |
| 9 | Artifacts | `npm run capabilities:build`, then `npm run capabilities:check -- --group <group>` |

Resources whose vendor API is thin (read-only, no filters, no text search — `api_info`, `magic_dash`,
`groups`, `users`) legitimately answer most of these with `null`: that is a documented absence, not a gap.
The one non-negotiable per resource is `resolve`.

---

## 7. Phase 2 — MCP projection and manifest

1. `npm run mcp:project` — the mechanical projection from the registry (tool list, `backingOperation`,
   schemas, annotations).
2. Curate on top: names, descriptions, tiers, token budget. Every change goes in
   `MCP_TOOL_OVERRIDES.json` at the repo root (`{tool, field, newValue, reason}`). Never edit the
   registry to fix a tool description.
3. Rules that apply: read tools are backed by the **helper tier** (`search`/`findBy*`/`resolve`), never
   `listAll`; bounded results (10–25 default, max 100); mutating tools expose a `dry_run` affordance that
   calls the SDK's dry-run path; sensitive/`requiresApproval` operations say so; no binary/download tools.
4. **Regenerate `examples/mcp-server.ts`** from the curated manifest as the reference consumer — the
   restored v2 example (from `HEAD`, see §4) is the starting point, not the target: it predates the helper
   tier and the registry projection. It must call the **helper tier** (`search`/`findBy*`/`resolve` /
   `getContext`), never `listAll`, and its tool definitions must match the manifest's names, descriptions and
   annotations. Commit it with the Phase 2 work.

---

## 8. Release

1. `package.json`: version **0.3.0**; `exports` gains `./capabilities` and (when present) `./operations`;
   `tsup.config.ts` entries gain `src/capabilities.ts` and `src/operations/index.ts`.
2. `npm run build` → verify the dist tree carries `.js`/`.cjs`/`.d.ts`/`.d.cts` for the barrel **and every
   subpath**.
3. `npm run lint` → `npm test` (coverage thresholds unchanged and met).
4. Public-surface snapshot test committed, proving no existing signature or return shape changed.
5. The checker's **negative fixture** committed (a deliberately drifted plan that must make
   `capabilities:check` exit non-zero) and run.
6. `npm run capabilities:check -- --ship` — every row `tested`, nothing left `planned` or `implemented`.
7. `CHANGELOG.md` entry in the user's voice; `README.md` gains an "agent helpers" section (resolve /
   findBy / search / getContext / dry-run / `compact` + `expand`); `docs/API.md` regenerated to include
   the new methods.
8. **Commit the whole alignment on the branch and open the PR.** One commit per group is fine (the plan
   rows, helpers and tests for that group together); a final commit carries the release artefacts. Nothing
   from §8 or the Phase 2 work may be left untracked — in particular `capabilities.plan.json`,
   `src/capabilities.ts`, the four scripts, `capabilities.json`, `capabilities.schema.json`,
   `MCP_TOOL_MANIFEST.md`, `MCP_TOOL_OVERRIDES.json` and the regenerated `examples/mcp-server.ts`.

---

## 9. QA phase — spawn the sub-agents on DeepSeek V4.1 Flash (xhigh)

### 9.0 Model policy — coding versus QA

| Role | Model |
|------|-------|
| **Primary coding** (Architect, implementers, tests, docs, toolsmith, shipper) | **Whatever the user selects.** Nothing is pinned in this note. Enumerate with `await rlm.find_models("<provider-or-name>")` and pass the returned `selector` verbatim, or omit `model=` to inherit the coordinator's model |
| **QA** (the five agents in §9.2) | Pinned to `openrouter/deepseek/deepseek-v4.1-flash` at thinking `xhigh` — deliberately a **different** model from the coding run, so the QA lens is not the author's lens |

Why QA is pinned and coding is not: a second pass on the same model tends to re-approve its own
assumptions, so QA gets a fixed, independent model; the coding model is a cost/quality choice that belongs
to the user and may change per session. Record the coding-model choice in `SCOPING.md` Section H, and keep
the QA pin in this section so a later run can still reproduce the review.

### 9.1 Model and level (verified 2026-09-12)

```python
QA_MODEL = "openrouter/deepseek/deepseek-v4.1-flash"   # from rlm.find_models("deepseek") — use verbatim
QA_THINK  = "xhigh"                                     # accepted for this model; the child session
                                                        # records thinkingLevel: "xhigh"
h = await rlm(BRIEF, name="qa-<area>", model=QA_MODEL, thinking=QA_THINK)
```

- Verified by an actual probe spawn: admission succeeded and the child's session header recorded
  `"thinkingLevel":"xhigh"` (no clamping). Valid levels are
  `off · minimal · low · medium · high · xhigh · max`.
- Because the model is passed explicitly, the QA children run on **openrouter**, not on the
  coordinator's provider — so they can run **in parallel** even if the coordinator is on a
  single-instance local model. Launch them all in one turn and collect replies as messages.
- `rlmMaxDepth` on this host is **2** (check `rlmMaxDepth` in `~/.prime/agent/settings.json`), so a QA
  child *can* spawn one level of its own helpers. Prefer not to rely on it: keep orchestration with the
  coordinator, and if a child does delegate, its descendants are invisible to you except through that
  child's report. (Some older guidance in `AGENTS.md` and the squad `SKILL.md` said depth 1 — corrected.)
- Admission returns immediately (`rlm_child_id`, `name`, `session_dir`); the children report back with
  `await agent_message.send(message, receiver_role='parent')`. Keep the handles.

### 9.2 Suggested QA roles (five, independent, read-only)

Each writes its findings to its own file under `/tmp/node-hudu-backfill-qa/` and replies with a short
summary. **Read-only: QA never edits the SDK.**

| Agent | Question it answers | Must check |
|-------|--------------------|-----------|
| `qa-contract` | Is coverage complete and is the contract intact? | Every one of the 158 operations has a plan row and either a primitive or an explicit reason; the envelope table (`ARCHITECTURE.md:753`) is honoured (PUT-unwraps-by-singleKey, void creates, non-paginated endpoints never send page params); **no existing public signature or return shape changed** (diff the exported surface against git `9332efe`) |
| `qa-agent-layer` | Do the helpers behave as specified? | Helper floor present and co-located, not thin aliases; no "do everything" method; the 2–4 cap respected **beyond the floor**; `resolve` returns `null` only after a complete scan and throws `RESOLUTION_TRUNCATED`/`RESOLUTION_AMBIGUOUS`; `{id}` miss throws `NOT_FOUND`; client scans bounded (`maxScanRecords`/`maxScanPages`, default 500); compact shapes declare dropped fields and primitives still return the full record |
| `qa-safety` | Can an agent do damage here? | Every mutation accepts `dryRun` and the dry-run path issues **no** mutating request (verify by reading the code path and the test, not the flag); `effect` + flags complete and correct; impact statement present; `staleCheck` answered; correlation id on success **and** error paths; audit/redaction: no credential-shaped field in logs; returned data never silently redacted |
| `qa-registry` | Do plan, registry and code agree? | `capabilities.plan.json` ↔ `src/capabilities.ts` ↔ `src/resources/*.ts` agree (no orphan record, no unplanned public method); `capabilities:check` genuinely fails on the negative fixture; emitted `capabilities.json` freshness (`planHash`); every record has ≥1 `example`, a `permissions` value or `"unknown"`, `preferredWhen` where operations overlap; `MCP_TOOL_MANIFEST.md` projects from the registry with `backingOperation` and no `listAll` tools |
| `qa-packaging` | Does it install and import as promised? | `exports` ↔ tsup entries ↔ emitted dist for every subpath (`.js`/`.cjs`/`.d.ts`/`.d.cts`); zero runtime deps added; `zod`/MCP SDK stay devDeps; `npm pack` a tarball and import it from ESM **and** CJS; README/docs examples actually run |

Run `qa-contract` and `qa-registry` first (factual), then `qa-agent-layer`/`qa-safety`/`qa-packaging`
against the same commit. Re-run any agent's area after you fix its findings; do not accept "fixed" without
a re-read.

### 9.3 Every QA brief must carry these four lines

```
BUDGET: at most <N> grounding calls (reads/greps/diffs). At call <N>, STOP reading and write your findings file with what you have.
SEEDS: <exact paths already collected — plan file, registry, resources dir, test dir, ARCHITECTURE.md, the spec, the git ref to diff against>. Do not re-derive any of this.
SKELETON FIRST: write your findings file skeleton to <output path> BEFORE further grounding, then fill it in incrementally.
PARTIAL REPLY: if the budget is spent or a claim is untested, deliver the partial with each gap marked UNVERIFIED. Silence is the only unacceptable outcome.
```

Add, verbatim: **READ-ONLY** (do not edit the SDK), the finding format
(`SEVERITY — what is wrong — file:line — why it matters — suggested fix`), the output path, and
"rank by severity, and include a short VERIFIED OK list so the coordinator knows what was actually
checked rather than assumed".

### 9.4 Child liveness and retirement

- **Liveness = the age of the child's last message** in
  `~/.prime/agent/session-artifacts/<root-session>/<sub-id>/<uuid>.jsonl`. Never trust `status` or
  `isStreaming`.
- Check at every gate and at least every 30 minutes. Past 2× the stated budget or 45 minutes (whichever
  is smaller): read the jsonl, delete the child, re-dispatch with the predecessor's transcript path and a
  tighter budget.
- **Retire by explicit `rlm_child_id` only** — never by name. A `cancelled: Deleted by parent
  orchestrator` notice for an id you retired is expected late noise: log it and ignore it.

### 9.5 Handling findings

For each finding: fix it (or record why it is accepted), re-run the affected gate, then ask the same
agent to re-check only that item. A finding is closed when a **gate** passes, not when a file changes.

---

## 10. Unattended overnight execution

The run is not a sweep you supervise. It is a **step machine that works while nobody is watching**, and it
must be safe to leave alone for 8–10 hours.

### 10.1 What changes when the user is asleep

| Supervised run | Unattended run |
|----------------|----------------|
| Ask when something is ambiguous | **Never ask.** Apply the documented default, record it as an *autonomous decision* with a reversal command, keep going |
| One long turn per phase | **Exactly one step per wake**, then end the turn. State lives on disk, never in session memory |
| Wait for a child before continuing | Start the child, record its handle, end the turn; the next wake collects it |
| Fix drift whenever it appears | Commit per completed step, so the branch is always a consistent, resumable state |
| Finish when the work is done | Finish when the work is done **or** the clock runs out — whichever comes first, and finalise cleanly |

Three things may **block** a step (record them and move to independent work; never guess): changing a
public contract, destroying user data or touching credentials, and anything that publishes or pushes outside
this repo.

### 10.2 The driver — one heartbeat, one step per wake

```python
await rlm_heartbeat.create(
    instruction=(
        "node-hudu unattended backfill — advance ONE step. "
        "1) Read /Users/maxs/gitrepos/node-hudu/.run/RUN-STATE.json (create it if absent, from "
        "BACKFILL-HANDOVER.md §10.4). "
        "2) If the local time is past stopBy minus 30 minutes, run the Finalise step (§10.7), pause this "
        "heartbeat, and report. "
        "3) Check every in-flight child by the AGE OF ITS LAST MESSAGE in its session jsonl (never by "
        "status): collect finished ones, run the gate for the step they were doing, then start the next "
        "pending step and END THE TURN. "
        "4) Append one line to .run/PROGRESS.log per step. "
        "5) Never ask the user anything: apply the documented default and record it in "
        "RUN-STATE.json under autonomousDecisions with an exact reversal command. "
        "6) Never sleep, never poll, never hold the turn open waiting on a child."
    ),
    interval="10m", label="node-hudu-backfill", delivery_mode="follow_up")
```

- **`delivery_mode="follow_up"`** so a wake never interrupts a turn that is doing work.
- **One heartbeat only.** The stop time lives in `RUN-STATE.json`, not in the heartbeat text, so you can move
  the deadline without recreating the job.
- Manage it with `await rlm_heartbeat.list()` / `update("<id>", status="pause")` / `delete("<id>")`.
- This replaces polling entirely: the harness forbids `sleep()`-loop waiting, and a heartbeat is the supported
  way to keep a long run moving across turns.

### 10.3 `RUN-STATE.json` — the single source of truth

Commit it (with `PROGRESS.log`) so a crash, a compaction or a new session can resume from git alone.

```json
{
  "runId": "node-hudu-backfill-20260912",
  "startedAt": "2026-09-12T23:00:00+10:00",
  "stopBy":   "2026-09-13T06:30:00+10:00",
  "branch": "feat/agent-execution-layer",
  "codingModel": null,
  "qaModel": "openrouter/deepseek/deepseek-v4.1-flash",
  "qaThinking": "xhigh",
  "step": "B.implement",
  "steps": {
    "preflight": "done", "plan_derive": "done",
    "A.design": "done", "A.implement": "done", "A.tests": "done", "A.qa": "done", "A.fix": "done",
    "B.design": "done", "B.implement": "running", "B.tests": "pending", "B.qa": "pending", "B.fix": "pending",
    "C.design": "pending", "C.implement": "pending", "C.tests": "pending", "C.qa": "pending", "C.fix": "pending",
    "D.design": "pending", "D.implement": "pending", "D.tests": "pending", "D.qa": "pending", "D.fix": "pending",
    "operations": "pending", "mcp_project": "pending", "release": "pending",
    "qa_final": "pending", "finalise": "pending"
  },
  "children": [
    { "name": "resource-impl-B", "id": "sub-…", "step": "B.implement",
      "startedAt": "2026-09-13T01:10:00+10:00", "budget": "45m", "log": ".run/logs/…jsonl" }
  ],
  "gates": { "A.check": "pass", "B.check": "—" },
  "blockers": [
    { "id": "B1", "step": "B.implement", "what": "Hudu exposes no filter for X", "since": "…",
      "needsUser": false, "action": "client scan with cap 500, recorded in the plan row" }
  ],
  "autonomousDecisions": [
    { "what": "findBySerial uses a bounded client scan", "why": "no vendor filter in api-docs.json",
      "reversal": "edit capabilities.plan.json row assets.findBySerial and re-run plan:derive" }
  ],
  "metrics": { "spawns": 6, "commits": 5, "gateRuns": 9, "qaFindings": 3, "qaFixed": 3 }
}
```

Rules: every step key gets one of `pending | running | done | blocked | skipped`; a step is `done` only when
its **gate** passed and the work is **committed**; `blocked` requires a `blockers` entry with the exact
question a human must answer.

### 10.4 The step ladder

One step = one wake's unit of work. Steps that spawn a child finish the wake immediately after recording the
handle; the next wake collects the result and runs the gate.

| Step | Work | Gate / evidence |
|------|------|-----------------|
| `preflight` | branch, backup, coding model, `SCOPING.md` (with the no-pilot waiver), four scripts + npm scripts | `SCOPING.md` confirmed-looking, plan file not yet required |
| `plan_derive` | `npm run plan:derive` | 158 rows, `group` populated, existing rows `implemented` |
| `<g>.design` | fill that group's judgement columns in the plan | every column answered (explicit `null`/`"none"`/`"unavailable"` allowed); every helper has a rationale |
| `<g>.implement` | helpers + base-class plumbing + safety + dry-run for the group's resources (≤8 resources per spawn) | `npx tsc --noEmit` green; `capabilities:build` clean; group rows `implemented` |
| `<g>.tests` | the §11 test rows for the group | `npm test` green, coverage thresholds unchanged, group rows `tested` |
| `<g>.qa` | **three** QA agents scoped to the group's diff — `qa-contract`, `qa-agent-layer`, `qa-registry` (§9.2) — read-only, findings to `.run/qa/<g>/` | three findings files exist, each severity-ranked; the other two lenses are deferred to `qa_final` |
| `<g>.fix` | apply findings, re-run the group gate | `capabilities:check -- --group <g>` passes; QA re-check of each fixed item. If the queue is long, `qa-safety`/`qa-packaging` can be deferred to `qa_final` — but a dry-run or redaction finding is never deferred |
| `operations` | cross-resource helpers in `src/operations/` + their plan rows | `capabilities:check` clean for `group: operations` |
| `mcp_project` | `mcp:project`, curation, `MCP_TOOL_OVERRIDES.json`, regenerate `examples/mcp-server.ts` | manifest gate (§7 rules) + example uses the helper tier, no `listAll` |
| `release` | version 0.3.0, exports/tsup, docs, changelog, negative fixture, `capabilities:check -- --ship` | `build` + `lint` + `test` green; `--ship` passes |
| `qa_final` | the five QA agents against the whole branch (`git diff main...HEAD`) | findings closed or recorded as blockers |
| `finalise` | `MORNING-REPORT.md`, commit everything, pause the heartbeat | report exists; `git status` clean; heartbeat paused |

Run the groups **A → B → C → D**, each fully closed (design → implement → tests → qa → fix) before the next
one starts. That ordering is what makes the QA findings actionable while the group is still fresh, and it
keeps any single group's blast radius small at 3 a.m.

### 10.5 Failure policy (never guess, never thrash)

| Situation | Action |
|-----------|--------|
| A gate fails on a few lines | Fix inline in the coordinator; re-run the gate |
| A gate fails structurally | Respawn that step **once**, with the failing diagnostics pasted verbatim |
| The same step fails twice | Mark it `blocked` with a precise question, move to the next independent step, keep working |
| A child stalls (no new message past 2× its budget or 45 min) | Read its jsonl, delete it by **explicit id**, re-dispatch with the predecessor's transcript path and a tighter budget |
| A test fails and the fix is not obvious | Do **not** weaken the test, lower thresholds, skip, or `--no-verify`. Record a blocker |
| Provider timeouts | Split the step; never raise `retry.provider.timeoutMs` |
| The safety guard blocks a command | Record what was blocked and continue elsewhere. Never re-word the command to evade it |
| Ambiguity in the vendor API | Choose the deterministic option, document it, add a reversal command |

### 10.6 Safety rails for an unattended run

- **Never commit or push to `main`.** Work on `feat/agent-execution-layer` only.
- **No force-push, no rebase of pushed history, no branch deletion, no `git reset --hard`, no
  `git checkout -- .`** on a dirty tree (it destroys work silently — this is the single most likely
  overnight accident).
- **No `npm publish`, no release creation, no PR merge** — open the PR and stop.
- **No credential reads**, no `.env` inspection, no printing of tokens; keep the existing logger redaction.
- **Never lower coverage thresholds, never skip or `.skip` a test, never disable a gate** to make a step pass.
- **No `rm -rf`** outside `.run/` scratch paths; the run must be reversible from git.
- Every autonomous decision carries a reversal command. A decision without one is not finished.

### 10.7 Time box and finalisation

- `stopBy` defaults to **06:30 local**. At `stopBy − 30 min` the run **starts no new step**; it only
  collects, commits and reports.
- **Finalise** (always, even when the work is unfinished): run whichever gates are runnable, commit
  everything on the branch (never leave uncommitted work — that is how an overnight run is lost), write
  `MORNING-REPORT.md`, pause the heartbeat, and end with a short status message.
- Partial is an acceptable outcome. A clean, resumable, well-reported partial beats a scrambled "almost
  everything".

### 10.8 `MORNING-REPORT.md` (write it to the repo root)

1. **TL;DR** — 3 lines: what is done, what is blocked, what to do first.
2. **Commits** — one line per commit (`hash — what changed`).
3. **Per group** — status, gate results, resources covered, anything skipped.
4. **QA** — per group: findings raised, fixed, deferred (with severity).
5. **Blockers** — each with the precise question a human must answer, and what it now blocks.
6. **Autonomous decisions** — what was decided, why, and the exact reversal command.
7. **Ledger** — spawns, commits, gate runs, QA findings, wall-clock per group.
8. **Resume** — the literal next command, e.g.
   `read BACKFILL-HANDOVER.md §10, .run/RUN-STATE.json, then continue from step C.design`.

### 10.9 Resuming after a crash, a compaction, or a new session

The state is reconstructible from files alone, by design:

1. `cat .run/RUN-STATE.json` → find the first step not `done`.
2. `git log --oneline main..HEAD` → confirm the commits that step claims exist.
3. `npm run capabilities:check` → confirm the plan/registry/code agreement the state claims.
4. Recreate the heartbeat if it is gone (`rlm_heartbeat.list()` first — never create a second one).
5. Continue from that step. **Never re-derive state from session memory**, and never restart the run from
   `preflight`: the branch already carries work, and `plan:derive` preserves judgement columns on re-run.

---

## 11. Definition of done

- [ ] `SCOPING.md` exists, confirmed, with Section J (retrofit, **no pilot — waiver recorded**), the chosen
      coding model in Section H, and the JSON block
- [ ] `capabilities.plan.json` covers all 158 operations; every judgement column answered explicitly
- [ ] Helper floor present on all 35 resources; cross-resource helpers in `src/operations/`
- [ ] Every mutation classifiable, dry-runnable, and dry-run proven not to write
- [ ] `src/capabilities.ts` generated; `capabilities.json` + `capabilities.schema.json` emitted at root
- [ ] `npm run capabilities:check -- --ship` passes, and the negative fixture fails as designed
- [ ] Structured error contract on the existing hierarchy, with `status` kept as a deprecated alias
- [ ] `MCP_TOOL_MANIFEST.md` projected + curated; `MCP_TOOL_OVERRIDES.json` records every deviation
- [ ] `npm run typecheck && npm run lint && npm test` green, coverage thresholds unchanged
- [ ] Public-surface snapshot test passes (additive only, proven)
- [ ] Dist verified for every subpath in both formats; `npm pack` imports from ESM and CJS
- [ ] CHANGELOG 0.3.0 + README agent-helpers section + docs/API.md updated
- [ ] QA findings from all five agents closed, with the affected gate re-run for each
- [ ] All work committed on the branch (or a PR opened) — the plan, the registry sources, the four scripts,
      the emitted JSON/schema, the manifest, the overrides file and the example
- [ ] **Unattended-mode artifacts** (§10): `.run/RUN-STATE.json` and `.run/PROGRESS.log` committed,
      `MORNING-REPORT.md` written, heartbeat paused, `git status` clean, and no step left `running`
- [ ] `examples/mcp-server.ts` restored from `HEAD`, regenerated against the curated manifest, and
      committed

---

## 12. Traps specific to this repo

| Trap | Handling |
|------|----------|
| Non-paginated endpoints receiving page params | The 8 listed in §2 plus `/exports`, `/api_info`. They already route through a single-fetch path — assert it in tests for the new helpers too |
| PUT unwrapping | PUT update **always** unwraps by `singleKey`, never by `createType`. A new helper that reuses `updateOne` inherits this for free; a hand-rolled request does not |
| Void creates | `exports` / `s3_exports` return empty 200. A dry-run diff for them has nothing to compare — say so in `warnings` |
| Company-scoped assets | `companies/{companyId}/assets` — the `assets` helpers need the company in scope; a `resolve` for an asset may need `{ companyId, id }` |
| Multipart endpoints | `public_photos` create/update; a dry-run must validate without building the multipart body twice |
| Coverage thresholds | 97/94/83/97 — higher than the squad's 90-line gate. Never lower them; add tests |
| `examples/mcp-server.ts` | Emptied in the working tree (318 deletions vs `HEAD`). Restore from `HEAD` in pre-flight, never commit the empty file, and regenerate it in Phase 2 against the curated manifest |
| Existing logger redaction | Extend `src/logger.ts` for the audit hook; do not add a second redactor |
| 30-minute provider timeout | Cap spawns at ~8 resources; never raise the timeout; a stuck request retries 3× |
| Version bump | 0.2.1 → **0.3.0**. Any breaking change discovered mid-sweep means stop and get a scope decision |
| Overnight: work left uncommitted | The likeliest way to lose a night. Commit per completed step; `finalise` refuses to end with a dirty tree |
| Overnight: destructive git habits | Never `git reset --hard`, `git checkout -- .`, force-push, or delete a branch. Those destroy unattended work with no user watching |
| Overnight: a stalled child blocks everything | Collect children by last-message age, not status; delete by explicit id and re-dispatch. Never wait on one child while other steps could advance |
| Overnight: session death or compaction | State is on disk by design (§10.9). Resume from `RUN-STATE.json` + `git log`; never restart from `preflight` |

---

## 13. Rollback

- Work happens on `feat/agent-execution-layer`; `git switch main` abandons it cleanly.
- Files added by the retrofit are new (`capabilities.plan.json`, `src/capabilities.ts`,
  `src/operations/`, `scripts/*.mjs`, the emitted JSON/schema, `MCP_TOOL_MANIFEST.md`,
  `MCP_TOOL_OVERRIDES.json`) — deleting them returns the tree to 0.2.1 plus the helper methods.
- The pre-change copy in `/tmp/node-hudu-backup-<timestamp>` (taken in §4) is the last resort.
- Nothing here touches `dist/` in a way that cannot be rebuilt with `npm run build`.

**Resume before you roll back.** A half-finished unattended run is normally resumable, not discardable: read
`.run/RUN-STATE.json`, check `git log --oneline main..HEAD`, and continue from the first step that is not
`done` (§10.9). Roll back only when the branch itself is unsound — a bad architectural decision baked into
many groups, or a corrupted plan — and say so in the morning report before doing it.

---

## 14. Copy-paste snippets

### 14.1 `SCOPING.md` skeleton (retrofit)

```markdown
# SCOPING — node-hudu backfill to api-node-squad 3.0.1

A. Use case: MCP server (primary) + general SDK consumers. Transport stays injectable.
B. Prior art: this repo's own ARCHITECTURE.md and git history (9332efe = 0.2.1 baseline).
C. Spec: local `api-docs.json` (Swagger 2.0), Hudu API 2.45.1.
D. Coverage: FULL SPEC — all 158 operations, additively.
E. Package: `node-hudu` (unchanged), MIT, npm, dual ESM+CJS, existing subpaths + ./capabilities [+ ./operations].
F. Runtime: node >=18, ZERO runtime deps, vitest (thresholds 97/94/83/97 — unchanged), tsup.
G. Repo: /Users/maxs/gitrepos/node-hudu, public, branch feat/agent-execution-layer, PR.
H. Models: PRIMARY CODING = <the model the user chose> (selector verbatim from rlm.find_models), or
   "inherit". QA = openrouter/deepseek/deepseek-v4.1-flash @ thinking xhigh (pinned for review only).
I. Special endpoints: non-paginated list (8), void creates (exports/s3_exports), multipart (public_photos),
   company-scoped assets, jump/lookup redirects, archive/unarchive void returns.
J. Agent execution layer: 3.0.x policy ADOPTED — helper floor <floor>, metadata <plan+registry+emission>,
   dry-run <all mutations>, classification <effect + flags>, client scan <bounded 500>, compact <helpers>,
   MCP tool projection <from registry, overrides in MCP_TOOL_OVERRIDES.json>.
   J3: EXISTING SDK → RETROFIT. **No bounded pilot — waived by the user (2026-09-12); full alignment of
   all 35 resources in one run. The per-group batch gate is the early-failure signal.**
CONFIRMED: <user>
```

```json
{
  "models": { "coding": "<user-selected selector or null to inherit>", "qa": "openrouter/deepseek/deepseek-v4.1-flash" },
  "thinking": { "qa": "xhigh" },
  "sectionJ": {
    "adopted": true,
    "optOut": false,
    "workflowResources": ["companies", "assets", "articles"],
    "getContext": true,
    "clientScanCap": 500,
    "dryRun": "all-mutations",
    "retrofit": true,
    "pilot": false,
    "pilotWaivedBy": "user decision 2026-09-12",
    "scope": "all 35 resources"
  }
}
```

### 14.2 Scripts and npm scripts to add

```
scripts/
  derive-plan.mjs            # api-docs.json + src/ -> capabilities.plan.json (derivable columns; idempotent)
  generate-capabilities.mjs  # plan + types -> src/capabilities.ts + capabilities.json + capabilities.schema.json
  check-capabilities.mjs     # the gate: --group <g> per batch, --ship at Ship, no flag = sanity
  project-mcp-tools.mjs      # registry -> mechanical MCP tool projection
capabilities.plan.json       # authored source (committed)
capabilities.json            # emitted at the repo root (committed — non-TS consumers)
capabilities.schema.json     # emitted at the repo root (committed)
```

```json
{
  "scripts": {
    "plan:derive": "node scripts/derive-plan.mjs",
    "capabilities:build": "node scripts/generate-capabilities.mjs",
    "capabilities:check": "node scripts/check-capabilities.mjs",
    "mcp:project": "node scripts/project-mcp-tools.mjs"
  }
}
```

**Always pass the extra `--`** when a flag follows the npm script name
(`npm run capabilities:check -- --group A`), or npm swallows it.

### 14.3 Gate commands, in order

```bash
npm run typecheck
npm run plan:derive                      # once, pre-Design
npm run capabilities:build               # after Types, then after every batch
npm run capabilities:check -- --group A  # per batch (rows must be `implemented`)
npm test                                 # Tests stage
npm run capabilities:check               # pre-Review sanity pass (planned still tolerated)
npm run mcp:project                      # MCP builds
npm run capabilities:check -- --ship     # Ship: every row `tested`
npm run build && npm run lint && npm test
```

### 14.4 QA launch

```python
CODING_MODEL = None            # or the user's selector from rlm.find_models(...); None = inherit
QA_MODEL = "openrouter/deepseek/deepseek-v4.1-flash"   # pinned for QA only
QA_THINK = "xhigh"
ROOT = "/Users/maxs/gitrepos/node-hudu"
OUT = "/tmp/node-hudu-backfill-qa"

# implementation spawns use the coding model (or inherit); QA spawns use the pinned pair above
# impl = await rlm(brief, name="resource-impl-A", **({"model": CODING_MODEL} if CODING_MODEL else {}))

brief = """<role brief>. SEEDS: ... BUDGET: ... SKELETON FIRST: ... PARTIAL REPLY: ..."""
qa1 = await rlm(brief, name="qa-contract",   model=QA_MODEL, thinking=QA_THINK)
qa2 = await rlm(brief, name="qa-agent-layer", model=QA_MODEL, thinking=QA_THINK)
qa3 = await rlm(brief, name="qa-safety",      model=QA_MODEL, thinking=QA_THINK)
qa4 = await rlm(brief, name="qa-registry",    model=QA_MODEL, thinking=QA_THINK)
qa5 = await rlm(brief, name="qa-packaging",   model=QA_MODEL, thinking=QA_THINK)
# all five run in parallel on openrouter; replies arrive as agent messages
```

### 14.5 Handy checks

```bash
rg -c '^- \[ \]' ~/.prime/agent/skills/api-node-squad/references/existing-node-checklist.md  # 71 items
rg -n 'listAll' MCP_TOOL_MANIFEST.md            # expect: no tool backing
rg -n 'dryRun' src/ | wc -l                     # dry-run plumbing exists
rg -n 'resolve\(|findBy[A-Z]|getContext\(' src/resources | wc -l   # helper tier present
git diff --stat main -- src/                    # additive-only review of the source delta
```

### 14.6 Bootstrap the unattended run (one cell, at the start)

```python
import json, os, datetime, pathlib

HO   = "/Users/maxs/gitrepos/node-hudu"
RUN  = pathlib.Path(HO) / ".run"
RUN.mkdir(exist_ok=True)
STOP = "2026-09-13T06:30:00+10:00"          # set the real deadline

STEPS = (["preflight", "plan_derive"] +
         [f"{g}.{s}" for g in "ABCD" for s in ("design", "implement", "tests", "qa", "fix")] +
         ["operations", "mcp_project", "release", "qa_final", "finalise"])

(RUN / "RUN-STATE.json").write_text(json.dumps({
    "runId": f"node-hudu-backfill-{datetime.date.today():%Y%m%d}",
    "startedAt": datetime.datetime.now().astimezone().isoformat(),
    "stopBy": STOP,
    "branch": "feat/agent-execution-layer",
    "codingModel": None,                     # the user's selector, or None to inherit
    "qaModel": "openrouter/deepseek/deepseek-v4.1-flash",
    "qaThinking": "xhigh",
    "step": STEPS[0],
    "steps": {s: "pending" for s in STEPS},
    "children": [], "gates": {}, "blockers": [], "autonomousDecisions": [],
    "metrics": {"spawns": 0, "commits": 0, "gateRuns": 0, "qaFindings": 0, "qaFixed": 0},
}, indent=2))
(RUN / "PROGRESS.log").touch()

# exactly one heartbeat; check first so you never stack two
existing = await rlm_heartbeat.list()
assert not [h for h in existing if getattr(h, "label", "") == "node-hudu-backfill"], existing
hb = await rlm_heartbeat.create(
    instruction=("node-hudu unattended backfill — advance ONE step per wake. Read .run/RUN-STATE.json; "
                 "if past stopBy minus 30m run the Finalise step and pause this heartbeat; otherwise "
                 "collect finished children (by last-message age in their session jsonl), run the gate for "
                 "the step they were doing, start the next pending step, append to .run/PROGRESS.log, and "
                 "end the turn. Never ask the user anything — record autonomous decisions with a reversal "
                 "command. Never sleep, never poll, never hold the turn open."),
    interval="10m", label="node-hudu-backfill", delivery_mode="follow_up")
print("heartbeat:", hb)
```

Then commit the bootstrap and stop touching the run by hand:

```bash
cd /Users/maxs/gitrepos/node-hudu
git add .run && git commit -m "chore: bootstrap unattended backfill run state"
```
