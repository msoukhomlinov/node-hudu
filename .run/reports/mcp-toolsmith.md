# MCP Toolsmith report — node-hudu agent-execution-layer retrofit (Phase 2, MCP projection)

Date: 2026-09-12 · branch `feat/agent-execution-layer` · scope: the MCP `tools/list` surface only.
Files owned/touched: `MCP_TOOL_OVERRIDES.json` (new), `MCP_TOOL_MANIFEST.md` (regenerated),
`examples/mcp-server.ts` (regenerated), `scripts/project-mcp-tools.mjs` (only the MCP-curation
capabilities: `--check-example`, the `exclude` override, the tier-classification line, and the
read-tier annotation scoping). Nothing in `src/**`, `test/**`, `capabilities.plan.json`,
`package.json`, `tsconfig*`, README/CHANGELOG/docs was touched. Not committed.

## 1. Final numbers (all green)

```
mcp:project — tools projected=147; excluded=22; overrides applied=644                    (exit 0)
mcp:project — read tools missing helper-tier backing: 0
mcp:project — classification by registry kind: helper-tier tools=62, primitive-read=0,
              primitive-write=85; re-pointed-by-curation=0; mislabelled=0
mcp:project — curation exclusions: 56 tool(s) dropped through MCP_TOOL_OVERRIDES.json;
              no two curated read tools share a backingOperation=true
mcp:project --check-example — examples/mcp-server.ts: 20 tool(s) registered (15 read, 5 mutating);
              manifest projects 147; 127 deliberately excluded                          (exit 0)
```

Independent one-line check over the manifest's machine-readable projection:

```
node -e '...' -> {"tools":147,"reads":62,"mutations":85,"distinctReadBackings":62,
                   "duplicateReadBackings":0,"readsNotHelperTier":0,"readsWithoutBound":0,
                   "toolsMissingTitleOrDescription":0}
```

Typechecks: `npx tsc --noEmit` = 0 errors (repo config, `src/**`); `examples/mcp-server.ts` =
0 errors under the repo's exact compiler options, verified **both** ways — through a temporary
`paths` map to `src/` and through the package's own name (`node-hudu` → built `dist/`, whose chunk
`dist/client-DNdEaPtK.d.ts` does carry the helper tier; my earlier "dist predates the helper tier"
note was wrong — the barrel `dist/index.d.ts` only re-exports from that chunk).
Not run (per brief): `npm test`, `capabilities:build`, `capabilities:check`.

## 2. `MCP_TOOL_OVERRIDES.json` — 644 records, `{tool, field, newValue, reason}`

| field | count | purpose |
| --- | --- | --- |
| `name` | 147 | verb-first, search-first name (`<prefix>_<verb>_<scope>`) for every surviving tool |
| `title` | 147 | human display name (the projection has no `title` field) |
| `description` | 147 | what it returns + its bound + when NOT to use it (+ flags for writes) |
| `annotations.bounded` | 62 | every read states "default 25 … hard maximum 100" |
| `inputSchema.opts` / `inputSchema.options` | 82 + 3 | removes the duplicate nested `dryRun` |
| `exclude` | 56 | drops one tool per redundant outcome, with its reason |

Each tool's `name` override comes first so later overrides resolve against the renamed entry;
`exclude` records reference the tool's un-renamed projection name and are therefore always
resolvable. All 644 applied; the script exits non-zero on any unresolved override.

## 3. Exclusive outcome ownership (no two tools do the same job)

After the 56 re-points, each redundant read was dropped through `exclude`, keeping the
better-named tool of the pair:

| was | re-pointed to (before exclusion) | kept instead | dropped |
| --- | --- | --- | --- |
| `<res>.get` | `<res>.resolve` | `hudu_get_<singular>` | 24 `hudu_get_<singular>_by_id` |
| `<res>.list` | `<res>.search` | `hudu_search_<resource>` | 9 `hudu_list_<resource>` |
| `<res>.list` | the list-shaped `findBy*` | `hudu_find_<resource>_by_<field>` | 7 `hudu_resolve_<singular>` |
| `<res>.list` (no multi-record helper) | `<res>.resolve` | `hudu_get_<singular>` | 13 `hudu_resolve_<singular>` |
| `<res>.jump` / `.lookup` | `<res>.resolve` | `hudu_get_<card/company>` | 3 `hudu_jump_*`, `hudu_lookup_*` |
| `assets.listAcrossCompanies` | `assets.search` | `hudu_search_assets` | 1 `hudu_list_assets_across_companies` |

Result: 147 tools = 62 reads (62 distinct `backingOperation`s, all helper-tier) + 85 mutations
(helpers do no writes, so every mutation keeps its own tool). Every dropped tool is listed in the
manifest under **"Excluded by curation (dropped through `MCP_TOOL_OVERRIDES.json`)"** with its
backing operation, effect, projected tier and the override's reason; the summary bullet
`excluded by curation: 56` makes the count visible in the header. Curated names, titles,
descriptions and bounds survive: 0 tools without a title/description, 0 reads without a bound,
0 unresolved overrides.

## 4. Dry-run, sensitive/approval, bounds (unchanged requirements, re-verified)

- `dry_run` appears **exactly once** per mutating tool (0 nested `"name":"dryRun"` in the manifest);
  each description states the SDK dry-run contract.
- 29 `requiresApproval`, 17 `sensitive`, 26 destructive tools state it in the description; the three
  bulk operations (`hudu_delete_all_activity_logs`, `hudu_delete_magic_dash_by_id`,
  `hudu_update_magic_dash_positions`) state their BULK impact bound and their `POLICY_DENIED` refusal.
- Every read states a bound; the eight `default ?` placeholders are gone.
- Mutation rows no longer carry the read-tier `helperTier*` annotation keys (a write is neither
  helper-backed nor a primitive read); they carry `tier="primitive-write"` only.

## 5. Script changes (all inside `scripts/project-mcp-tools.mjs`)

1. **`exclude` override** — `{tool, field: "exclude", newValue: true, reason}` removes the tool from
   the projection, records it in `curationExcluded`, prints it in the manifest section, and is
   counted in `overrides applied`. `newValue` other than `true` is rejected as unresolved.
2. **Tier classification line** — re-pointed (`registryKind=primitive`, `tier=helper`) is now
   reported separately from genuinely mislabelled (`registryKind=helper`, `tier!=helper`), which
   must be 0. Plus a curation line that asserts no two read tools share a `backingOperation`.
3. **Read-tier annotations** — `helperTierBacked` / `helperTierBacking` / `helperTierAlternatives`
   are only emitted for reads.
4. **`--check-example`** (from the first pass) — fails on an unknown tool name, any
   `listAll(`/`listPages(`/streaming `.list(`, a mutating tool without a `dry_run` affordance or
   without a `{ dryRun: true }` call, or a description that drifts from the curated manifest.
   Negative fixtures (each exit 1, rebuilt against the final example):

   | fixture | failure reported |
   | --- | --- |
   | `hudu_get_company` → `..._v2` | not a tool in the curated manifest |
   | a curated-**excluded** tool registered (`hudu_get_company_by_id`) | not a tool in the curated manifest |
   | `hudu.companies.listAll()` | uses an unbounded read (listAll() |
   | streaming `hudu.companies.list({})` | uses an unbounded read (.list() |
   | `dry_run` field removed | mutating tool with no dry_run input affordance |
   | `{ dryRun: true }` → `{ dryRun: false }` | never calls the SDK's { dryRun: true } path |
   | one word of a description changed | description drifts from the curated manifest |

## 6. `examples/mcp-server.ts` — reference consumer, now 20 tools

Regenerated (MCP v2 SDK + zod v4 + `structuredContent`/`outputSchema`, `_meta` with
`backingOperation`/`sensitive`/`requiresApproval`, error path surfacing `HuduError.code`, no new
dependency). Reads (15) are all helper-tier: `hudu_search_across_resources`, `hudu_resolve_any`
(`client.operations.searchAcrossResources` / `resolveAny`), `hudu_search_companies`,
`hudu_get_company`, `hudu_get_company_context`, `hudu_find_companies_by_domain`,
`hudu_search_articles`, `hudu_get_article`, `hudu_search_assets`, `hudu_get_asset`,
`hudu_get_asset_context`, `hudu_search_asset_passwords`, `hudu_get_asset_password`,
`hudu_search_users`, `hudu_get_procedure_with_tasks`. Mutations (5) each dry-run first:
`hudu_create_company`, `hudu_update_company`, `hudu_archive_company`, `hudu_delete_company`,
`hudu_delete_asset_password` (sensitive + approval-gated). No `listAll`, `listPages` or streaming
`list` call anywhere. `hudu_get_company_by_id` was removed when curation dropped it — the gate
already fails if an example tool is not in the curated manifest.

## 7. Deliberately excluded from the example (127 of 147)

| group | count | why |
| --- | --- | --- |
| other resources' canonical helper reads (all but companies/articles/assets/users/procedures) | 47 | token budget: one instance of each read *pattern*, not all 35 resources |
| mutations other than the five shown (incl. the 3 bulk operations) | 80 | each needs a resource-specific payload; the five cover create / update+stale-guard / archive / delete / approval-gated sensitive delete, and a reference server must not register a bulk delete by default |
| the 22 rule-excluded registry operations (`exports`, `photos`, `public_photos`, `uploads`, `s3_exports`) | — | never projected (binary/download surfaces) |

## 8. Residual findings

- **F1 — resolved** as recommended: the 56 duplicate-outcome reads are excluded by curation, one
  tool per outcome, each with a recorded reason and a visible manifest section.
- **F2 — fixed:** the console line no longer labels the curated re-points as mislabels; re-pointed
  and mislabelled are separate counters (both 0 now that the aliases are merged away).
- **F3 — fixed:** mutation rows no longer carry the read-oriented `helperTier*` keys.
- **F4 — withdrawn:** `websites.search` / `groups.search` / `passwordFolders.search` accept
  `{ limit }` after impl-A2's overload fix, and `dist/` does carry the helper tier; the example
  typechecks against both `src` and `dist`.
- **UNVERIFIED:** no live Hudu credentials, so the example's runtime behaviour is not exercised;
  `--check-example` is a static gate and cannot see a primitive reached through an indirection
  defined outside the file.

## 9. Commands run

```
node scripts/project-mcp-tools.mjs                      # exit 0; 147 tools; overrides 644
node scripts/project-mcp-tools.mjs --check-example      # exit 0
node scripts/project-mcp-tools.mjs --check-example --example /tmp/w-*.ts   # 7 fixtures, exit 1 each
node -e '<read-backing check over MCP_TOOL_MANIFEST.md>'  # duplicateReadBackings=0, readsNotHelperTier=0
npx tsc --noEmit                                        # exit 0
npx tsc -p /tmp/hudu-example-tsconfig.json              # exit 0 (example, node-hudu -> src)
npx tsc -p /tmp/hudu-example-tsconfig-dist.json         # exit 0 (example, node-hudu -> dist)
```
