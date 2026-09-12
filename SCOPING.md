# SCOPING — node-hudu backfill to api-node-squad 3.0.1

**Run:** `node-hudu-backfill-20260912` · **Branch:** `feat/agent-execution-layer` · **Baseline:** `main` @ `9332efe` (0.2.1 → 0.3.0, minor)
**Policy:** `~/.prime/agent/skills/api-node-squad/references/agent-execution-layer.md` (3.0.1) · **Path:** `accommodation-runbook.md` Phase F (additive retrofit)

A. **Use case:** MCP server (primary) + general SDK consumers. Transport stays injectable; no runtime deps.
B. **Prior art:** this repo's own `ARCHITECTURE.md` and git history (`9332efe` = 0.2.1 baseline).
C. **Spec:** local `api-docs.json` (Swagger 2.0), aligned to Hudu API 2.45.1 — 82 paths · 158 operations · 35 definitions.
D. **Coverage:** FULL SPEC — all 158 operations, additively. No bounded pilot (see J3).
E. **Package:** `node-hudu` (unchanged), MIT, npm, dual ESM+CJS, existing subpaths + `./capabilities` (+ `./operations` when present).
F. **Runtime:** node >=18, ZERO runtime deps, vitest (thresholds 97/94/83/97 — unchanged), tsup.
G. **Repo:** `/Users/maxs/gitrepos/node-hudu`, public, branch `feat/agent-execution-layer`, PR at the end.
H. **Models:** PRIMARY CODING = `inherit` (the coordinator's model, `openrouter/deepseek/deepseek-v4.1-flash`, high thinking) unless the user overrides before the first implement step — see the open decision below.
   QA = `openrouter/deepseek/deepseek-v4.1-flash` @ thinking `xhigh` (pinned for review only, per handover §9).
I. **Special endpoints:** non-paginated lists (`/ip_addresses`, `/lists`, `/networks`, `/procedure_tasks`, `/rack_storage_items`, `/rack_storages`, `/vlan_zones`, `/vlans`, `/exports`) must never receive `page`/`page_size`; void creates (`exports`, `s3_exports`); multipart (`photos` create, `public_photos` create/update, `uploads` upload); company-scoped assets (`/companies/{companyId}/assets*`); jump/lookup redirects (`companies.jump`, `cards.jump`, `cards.lookup`); archive/unarchive return void; PUT always unwraps by `singleKey`, never `createType`.
J. **Agent execution layer:** 3.0.x policy ADOPTED — helper floor `resolve` everywhere + `findBy<Field>` where the vendor filters + `search` where text search exists + `getContext` on the approved workflow resources; metadata = plan + registry + emission; dry-run on ALL mutations; classification `effect` + flags; bounded client scan cap 500 / 4 pages; compact = helper-tier only; MCP tool projection from the registry with overrides in `MCP_TOOL_OVERRIDES.json`.
   **J3: EXISTING SDK → RETROFIT. No bounded pilot — waived by the user (2026-09-12); full alignment of all 35 resources in one run.** The per-group batch gate plus per-group QA is the early-failure signal that replaces the pilot.

```json
{
  "models": { "coding": null, "qa": "openrouter/deepseek/deepseek-v4.1-flash" },
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

`models.coding: null` = every coding spawn omits `model=` and inherits the coordinator's. Reversal: set `codingModel` in `.run/RUN-STATE.json` (and this block) to a selector from `await rlm.find_models("<provider>")`, then re-dispatch the affected step.

---

## 2.1 Audit score — `accommodation-runbook.md` §2.1 A–H (measured 2026-09-12, `main` @ `9332efe`)

| Area | Score | Evidence |
|------|-------|----------|
| A. Envelope Normalisation | **5** | `singleKey`/`listKey`/`createType` per resource; PUT always unwraps by `singleKey`; `unwrapList` tolerates empty/absent envelopes; non-paginated path strips `page`/`page_size` |
| B. Error Hierarchy | **5** | `HuduError` base + status subclasses (400/401/403/404/405/406/422/429/5xx) with `.code` + `.status`; `errorFromStatus`; body-message extraction |
| C. Pagination Support | **5** | `list()` AsyncIterable + `listPages()` + `listAll()`; 9 non-paginated endpoints single-fetch; no-progress guard |
| D. Type Safety | **5** | 40 type files, zero `any` in real positions (`noImplicitAny` clean); generics on the base class |
| E. Public API Surface | **5** | Barrels + 5 subpaths; consistent `get`/`list`/`listAll`/`create`/`update`/`delete` |
| F. MCP Readiness | **5** | No MCP/zod import in `src/`; plain `T`/`T[]`; `listAll` convenience; `examples/mcp-server.ts` already MCP v2-aligned |
| G. Test Coverage | **5** | 98.17 lines / 96.7 functions / 85.87 branches; thresholds 97/94/83/97 |
| H. Agent Execution Layer Readiness | **3** | Convenience methods (`listAll`, special ops) and solid pagination/errors, but NO helper tier, NO capability metadata, NO classification/dry-run, NO resolution |
| **Total** | **38 / 40 (95 %)** | Band 88–100 % → *light touch*: Phases C, E and **F** (this run) |

Automated checks at baseline: `rg -n 'resolve\(|findBy|getContext' src/resources | wc -l` → **0**; `ls capabilities.plan.json src/capabilities.ts` → **absent**; `rg -n 'dryRun' src/ | wc -l` → **0**; `rg -n 'suggestedAction|category|retryable' src/errors.ts` → **0**.

---

## Design decisions locked for this run (coordinator)

These are the cross-cutting decisions every group inherits. They are recorded here because a
coordinator-run retrofit has no separate Architect spawn.

1. **Plan is the source.** `capabilities.plan.json` is authored (judgement columns) and `src/capabilities.ts` / `capabilities.json` / `capabilities.schema.json` are generated. Never hand-edit a generated file. Regenerate after every batch.
2. **Error-code vocabulary.** The registry `errors` column lists the SCREAMING_SNAKE codes the SDK **actually throws** (so a test row can assert them): `BAD_REQUEST` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405), `NOT_ACCEPTABLE` (406), `CONFLICT` (409), `STALE_OBJECT` (412), `UNPROCESSABLE_ENTITY` (422), `RATE_LIMIT` (429), `SERVER_ERROR` (5xx), `NETWORK_ERROR` (transport, including timeouts), plus the new agent-layer codes `RESOLUTION_TRUNCATED`, `RESOLUTION_AMBIGUOUS`, `DUPLICATE_FOUND`, `POLICY_DENIED` where the behaviour exists. New classes are additive: `ConflictError` (409), `StaleObjectError` (412); the existing classes keep their current `code` and gain `category`, `operation`, `retryable`, `httpStatus`, `vendorError`, `resourceIds`, `suggestedAction`, `correlationId`. `status` stays as a deprecated alias of `httpStatus`. **Rationale:** a registry that names codes the codebase never throws produces test rows that cannot be written.
3. **Transport-level plumbing lives in `src/http.ts`; resource-level plumbing in `src/resources/base.ts`.** Correlation id generation, the optional `onAudit` hook, the request-level `dryRun` short-circuit and the `DryRunResult` builder are implemented ONCE there and inherited by all 35 resources. No copy-paste per resource.
4. **Dry-run contract.** `{ dryRun: true }` on create/update/delete/archive/unarchive (and the special writers). The dry-run path builds the request description, validates inputs, verifies referenced resources where a lookup exists, and returns `DryRunResult<T>` with `simulated: true`. A spy on the transport must show **no mutating request**. Bulk-shaped mutations (`activity_logs.deleteAll`, `magic_dash.delete` by title) additionally declare `impact.scope` and refuse to run unconfirmed (`POLICY_DENIED`) when the target set is not bounded by explicit ids.
5. **`staleCheck`.** Hudu exposes no `If-Match`/ETag and declares no 409/412 responses in `api-docs.json`. Decision: `staleCheck: "updated_at"` **only** where (a) the resource's record type declares `updated_at` AND (b) the update path goes through `BaseResource.updateOne`, which is where the opt-in `{ expectedUpdatedAt }` guard is implemented (read-then-compare before the PUT; mismatch → `StaleObjectError`, code `STALE_OBJECT`, category `conflict`). Everywhere else `"unavailable"` — an explicit, documented absence. The guard is **opt-in** (`expectedUpdatedAt` is undefined by default) so no existing call changes behaviour.
6. **Compact shapes.** Each resource's summary shape (`CompanySummary`, `AssetSummary`, `ArticleSummary`, `WebsiteSummary`, `AssetPasswordSummary`, …) is declared in that resource's own type file (`src/types/<resource>.ts`), so four group implementers can work in parallel without fighting over one file. The four **layer** types (`OperationMetadata`, `DryRunResult<T>`, `Resolution<T>`, `FieldDiff`) plus `AuditEvent`, `Identifier` and the option bags are declared once in `src/types/common.ts`. Helpers return the compact shape by default with `expand: true`; primitives keep returning the full record. Compact shapes never drop `id`/`name`/the field a caller resolves by.
7. **Resolution.** `resolve(identifier, opts?)` on all 35 resources. `{ id }` → direct fetch, an id miss throws `NOT_FOUND` (never `null`). Bare values follow the policy order (numeric id → external id → exact name → domain), narrowed per resource in `usage`. `resolutionDetails: true` returns `Resolution<T>`. Client scans are bounded (500 records / 4 pages by default, configurable in client config) and throw `RESOLUTION_TRUNCATED` at the cap; an inexact filter with multiple matches throws `RESOLUTION_AMBIGUOUS` with candidate ids in `resourceIds`.
8. **Per-resource helper cap.** The floor (`resolve`, `findBy<Field>`, `search`, `getContext`) is not counted; at most 4 helpers beyond the floor per resource, each needing a `helperRationale` that names the round trips or reasoning it removes.
9. **Groups.** A = companies, articles, assets, asset_layouts, asset_passwords, websites, folders, password_folders, groups (52 rows). B = networks, vlans, vlan_zones, ip_addresses, rack_storages, rack_storage_items, relations, flags, flag_types (43 rows). C = procedures, procedure_tasks, cards, activity_logs, expirations, matchers, magic_dash, api_info (29 rows). D = uploads, photos, public_photos, exports, s3_exports, lists, label_types, labels, users (34 rows). Closed A → B → C → D.
10. **Workflow resources** (`getContext`): `companies`, `assets`, `articles` — the platform's primary nouns an agent needs context for.
11. **Coverage thresholds are frozen** at 97/94/83/97. Tests are added, never weakened.
12. **Additive only.** A public-surface snapshot test proves it. No existing signature, return shape, or error-code meaning changes.
13. **One plan row per helper.** A helper that does not map 1:1 onto one endpoint gets its OWN row: `endpoint: null`, `primitive: null`, `helper: "<resource>.<name>"`, `group: <the owning resource's group A-D>` (or `operations` for a cross-resource helper in `src/operations/`). Every row therefore has **exactly one** of `primitive`/`helper` non-null. Rationale: each helper is registered, gated, tested and status-tracked independently, so "a helper that appears in the plan but not in the code" is a precise, per-operation failure instead of a row-level one. Helper rows carry the full key set.
14. **`resolve` on every resource, including the degenerate ones.** 33 resources resolve a real record. `magic_dash.resolve` resolves by `{ title, company_id }` (the vendor's natural key). `api_info` is a singleton document with no identifier: `api_info.resolve()` is implemented as the documented degenerate case — it ignores the identifier, returns the singleton, and says so in `usage` and `helperRationale`. This keeps the "`resolve` everywhere" floor true without inventing a lookup the vendor cannot support.
   The single exception is **`s3_exports`**, which is write-only: `POST /s3_exports` returns void and there is no list, get or delete endpoint, so there are no records to resolve and it has **no helper rows at all** — a documented absence, not an omission. Its one primitive row still carries the full classification, dry-run and error contract.

CONFIRMED: coordinator, 2026-09-12 (unattended mode — decisions above are recorded, not asked)
