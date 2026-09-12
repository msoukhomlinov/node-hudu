# MCP Toolsmith report — node-hudu agent-execution-layer retrofit (Phase 2, MCP projection)

Date: 2026-09-12 · branch `feat/agent-execution-layer` · scope: MCP `tools/list` surface only.
Files owned and touched: `MCP_TOOL_OVERRIDES.json` (new), `MCP_TOOL_MANIFEST.md` (regenerated),
`examples/mcp-server.ts` (regenerated), `scripts/project-mcp-tools.mjs` (only the new
`--check-example` capability). Nothing in `src/**`, `test/**`, `capabilities.plan.json`,
`package.json`, `tsconfig*`, README/CHANGELOG/docs was touched. Not committed.

## 1. Status (all green)

- `node scripts/project-mcp-tools.mjs` → **overrides applied = 1260**, tools projected = 203
  (helper-tier **118**, **read primitives 0**, mutations 85), excluded by rule = 22.
- "read tools missing helper-tier backing" = **0**; the script's warning line reads
  `0 read tool(s) are still backed by a plain primitive`. The manifest's
  "Helper-tier gaps" list is now `- none`.
- `node scripts/project-mcp-tools.mjs --check-example` → **OK** (exit 0) on the real example, and
  **FAILS (exit 1)** on seven deliberately broken `/tmp` copies (§6).
- `npx tsc --noEmit` (repo config, `src/**`) → 0 errors.
- Example typecheck → 0 errors, via a temporary config that uses the repo's exact compiler options
  and maps `node-hudu` → `src/index.ts` + `node-hudu/operations` → `src/operations/index.ts`
  (`/tmp/hudu-example-tsconfig.json`). The repo `tsconfig.json` includes only `src/**/*.ts`, so the
  example is not covered by `npx tsc --noEmit`; and `dist/` predates the helper tier (`findByDomain`
  is absent from `dist/index.d.ts`), so a self-name import would not resolve the helper methods.
  A real consumer needs `npm run build` first — see finding F4.
- Not run (per brief): `npm test`, `capabilities:build`, `capabilities:check`.

## 2. `MCP_TOOL_OVERRIDES.json` — 1260 records, `{tool, field, newValue, reason}`

| field | count | what it does |
| --- | --- | --- |
| `name` | 203 | verb-first, search-first rename of every projected tool (`<prefix>_<verb>_<scope>`) |
| `title` | 203 | human display name (the projection has no `title` field) |
| `description` | 203 | what it returns + its bound + when NOT to use it (plus flags for writes) |
| `annotations.bounded` | 118 | a real bound on every read: "default 25 … hard maximum 100" |
| `inputSchema.opts` / `inputSchema.options` | 85 | removes the duplicate nested `dryRun` (rule c) |
| `backingOperation` | 56 | re-points every primitive read to the helper tier (rule a) |
| `inputSchema`, `outputSchema` | 56 + 56 | taken from the helper operation, so the manifest is truthful about what the tool now calls |
| `annotations.tier` / `helperTierBacked` / `helperTierBacking` / `helperTierAlternatives` / `curation` | 56 each | records the re-point in the manifest itself |

Order matters: each tool's `name` override comes first, so every later override for that tool
resolves against the renamed entry. Verified: the new-name set and the old-name set are disjoint.

## 3. Re-pointing the 56 primitive reads (rule a)

Every projected read now names a helper operation as its `backingOperation`:

| primitive | re-pointed to | tools |
| --- | --- | --- |
| `<res>.get` (id-only fetch) | `<res>.resolve` | 24 |
| `<res>.list` (streaming list) | `<res>.search` | 9 |
| `<res>.list` | the resource's list-shaped `findBy*` (`findByResource`, `findByFlagable`, `findByLabelable`, `findByEndpoints`, `findByName`, `findByCompany`) | 7 |
| `<res>.list` — resource has **no** multi-record helper | `<res>.resolve` (13), stated in the description as a deliberate narrowing to one record | 13 |
| `<res>.jump` | `<res>.resolve` | 2 |
| `<res>.lookup` | `<res>.resolve` | 1 |
| `assets.listAcrossCompanies` | `assets.search` | 1 |

Name consequences: `get` → `hudu_get_<singular>_by_id` (the direct-id path; a miss throws
`NOT_FOUND`), `list` → `hudu_list_<resource>`, narrowed lists → `hudu_resolve_<singular>`,
`jump`/`lookup` keep their special-op verb (`hudu_jump_company`, `hudu_lookup_card`). Every alias
carries `annotations.curation` naming the canonical tool it shares a backing with.

## 4. Bounds (rule b)

All 118 reads carry `annotations.bounded` **and** a "Bounded: …" sentence in the description:
- 90 search/list reads: "default 25 results, hard maximum 100";
- 4 context reads (`getContext`, `getWithTasks`): "default 25 records per sub-list, hard maximum 100";
- 24 direct-id reads: "direct id fetch (one request); … default 25 / hard maximum 100 on the
  scan path".

The 8 `default ?` placeholders (`ip_addresses.list`, `lists.list`, `networks.list`,
`procedure_tasks.list`, `rack_storage_items.list`, `rack_storages.list`, `vlan_zones.list`,
`vlans.list`) are gone: those tools are re-pointed and re-bounded by override. (The only remaining
`default ?` strings in the file are inside the override *reason* text that documents the change.)

## 5. Dry-run appears exactly once (rule c)

The projection carried the registry's nested `opts.dryRun` (82 tools) or `options.dryRun` (3) *and*
the script-injected top-level `dry_run`. Every nested entry is removed by override; the top-level
`dry_run` — the actual tool affordance the example and a gateway call — is kept. Result:
`"name":"dryRun"` = 0 occurrences in the manifest; every mutating tool has exactly one `dry_run`.
The registry metadata is not edited: the delta is in `MCP_TOOL_OVERRIDES.json`.

## 6. Sensitive / requiresApproval statements (rule d)

- 29 `requiresApproval` tools: description says "requiresApproval: the MCP gateway must obtain
  explicit human approval before this tool runs".
- 17 `sensitive` tools: description says "Sensitive: … the SDK redacts those fields by default"
  (reads) / "never echo a secret value …" (writes).
- 26 destructive tools: "Irreversible — dry-run first and prefer archive where the vendor offers it."
- The three bulk operations (`activity_logs.deleteAll` → `hudu_delete_all_activity_logs`,
  `magic_dash.deleteById` → `hudu_delete_magic_dash_by_id`,
  `magic_dash.updatePositions` → `hudu_update_magic_dash_positions`) each state their BULK impact
  bound ("every activity log from the given datetime on", "every Magic Dash item carrying that
  title", "every item in the submitted array") and their `POLICY_DENIED` refusal.
- Verified mechanically: 0 tools with a flag but no matching statement in the description
  (approval / sensitive / destructive / bound / "do not use" / dry-run).

## 7. Naming (rule e)

Search-first and verb-first everywhere: `hudu_search_<resource>`, `hudu_get_<singular>`,
`hudu_get_<singular>_context`, `hudu_find_<resource>_by_<field>`, `hudu_get_<singular>_by_id`,
`hudu_list_<resource>`, `hudu_resolve_<singular>`, `hudu_create|update|delete|archive|unarchive_<singular>`,
plus `hudu_search_across_resources`, `hudu_resolve_any`, `hudu_get_procedure_with_tasks`. 203
distinct names, asserted collision-free against both the new and the old name sets.
The standard's `list_` verb is used only for the bounded list tools that are genuinely
multi-record; the narrowed ones are named `hudu_resolve_<singular>` so the name does not promise a
list the tool no longer provides.

## 8. `examples/mcp-server.ts` — regenerated reference consumer (21 tools)

Official MCP v2 SDK (`@modelcontextprotocol/server` + `/stdio`), zod v4 (`import * as z from 'zod/v4'`),
`structuredContent` + `outputSchema` on every tool, error path surfacing `HuduError.code`, and
`_meta` carrying `backingOperation` / `sensitive` / `requiresApproval` for a gateway (the SDK's
`ToolAnnotations` type has only the four hint keys, so the two policy flags ride in `_meta` **and**
in the description). No dependency added.

- Reads (16), all helper-tier: `hudu_search_across_resources`,
  `hudu_resolve_any`, `hudu_search_companies`, `hudu_get_company`, `hudu_get_company_by_id`,
  `hudu_get_company_context`, `hudu_find_companies_by_domain`, `hudu_search_articles`,
  `hudu_get_article`, `hudu_search_assets`, `hudu_get_asset`, `hudu_get_asset_context`,
  `hudu_search_asset_passwords`, `hudu_get_asset_password`, `hudu_search_users`,
  `hudu_get_procedure_with_tasks` — `client.operations.searchAcrossResources` / `resolveAny` for the
  cross-resource pair, `search` / `findBy*` / `resolve` / `getContext` otherwise. No `listAll`,
  `listPages` or streaming `list` call anywhere.
- Writes (5), each exposing `dry_run` and calling `{ dryRun: true }` before the live path:
  `hudu_create_company`, `hudu_update_company` (with the opt-in `expectedUpdatedAt` stale guard),
  `hudu_archive_company`, `hudu_delete_company`, `hudu_delete_asset_password` (sensitive +
  approval-gated — the one place the example shows a secret-bearing write).
- Names, titles, descriptions and hint annotations are taken from the curated manifest; the
  checker enforces the descriptions verbatim.

## 9. `--check-example` (new capability in `scripts/project-mcp-tools.mjs`)

`node scripts/project-mcp-tools.mjs --check-example [--example <path>]` fails (exit 1) on:
1. a registered tool name that is not in the curated manifest;
2. any unbounded read (`listAll(` / `listPages(` / a streaming `.list(`) — comments and string
   literals are stripped first, because curated descriptions legitimately mention `users.listAll`;
3. a mutating tool with no `dry_run` in its **config** (input affordance), or one whose handler
   never calls the SDK's `{ dryRun: true }` path;
4. a description that is not the curated one, verbatim.
It also prints the reference-consumer coverage line: 21 registered, 203 projected, 182 excluded.

Negative fixtures (all exit 1, one failure each, on `/tmp` copies of the real file):

| fixture | failure reported |
| --- | --- |
| `hudu_get_company` → `hudu_get_company_v2` | not a tool in the curated manifest |
| `hudu.companies.listAll()` in a handler | uses an unbounded read (listAll() |
| streaming `hudu.companies.list({})` | uses an unbounded read (.list() |
| `dry_run` field removed (last mutating tool) | mutating tool with no dry_run input affordance |
| `dry_run` field removed (mid-file mutating tool) | same |
| `{ dryRun: true }` → `{ dryRun: false }` | never calls the SDK's { dryRun: true } path |
| one word of a description changed | description drifts from the curated manifest |

## 10. Tools deliberately EXCLUDED from the example (182 of 203)

| group | count | why |
| --- | --- | --- |
| re-pointed alias reads (`hudu_list_*`, `hudu_resolve_*`, `hudu_jump_*`, `hudu_lookup_*`) | 55 | they share the backing operation of a canonical helper tool; a reference server should expose the canonical name, not both, so the token cost of a duplicate surface is not paid. (`hudu_get_company_by_id` is the single deliberate exception: it demonstrates the narrow direct-id entry point next to `hudu_get_company`.) |
| other canonical helper reads (all resources but companies/articles/assets/users/procedures) | 47 | token budget: the example teaches one instance of each read *pattern*, not all 35 resources. |
| mutations other than the five shown | 80 | each needs a resource-specific payload; the five cover create / update+stale-guard / archive / delete / approval-gated sensitive delete. |
| the three bulk operations | (inside the 80) | a reference server must not register a bulk delete or a bulk position rewrite by default; their manifest descriptions state the impact bound. |
| the 22 rule-excluded registry operations (`exports`, `photos`, `public_photos`, `uploads`, `s3_exports`) | — | not projected at all (binary/download surfaces). |

## 11. Findings, recommendations, and what is UNVERIFIED

- **F1 (structural, needs a coordinator decision).** The projection has no merge or exclude
  capability, so re-pointing a primitive read to a helper leaves **two tools with the same backing
  operation and the same schemas** (e.g. `hudu_list_companies` and `hudu_search_companies` both call
  `companies.search`). All 56 are recorded explicitly (`annotations.curation`, plus the override
  table), and the example exposes only the canonical name — but the manifest still projects 203
  tools where ~147 unique outcomes exist. Recommended: drop the primitive rows at the plan level, or
  add an `exclude` field to the override schema. Not done here: the brief restricted my script
  ownership to `--check-example`.
- **F2 (cosmetic).** The script's console line
  `classification by registry kind: … mislabelled=56` counts the 56 curated re-points, because
  `registryKind` deliberately stays `primitive` (the registry record is a primitive; the *tool* is
  helper-backed by curation). A future edit to that line should count a re-point separately.
- **F3 (cosmetic).** Mutating records still carry the read-oriented annotations
  `helperTierBacked=false` and `helperTierAlternatives=[…]`. A mutation is neither helper-backed nor
  primitive-backed; those two keys are noise on the 85 writes.
- **F4 (src-side finding, not mine to change).** `websites.search`, `password_folders.search` and
  `groups.search` cannot be called as `search(q, { limit })` under their declared overloads
  (only `search(q)` or `search(q, { expand: true, … })`), which is why `src/operations/operations.ts`
  casts two of them to `CompactSearch`. The example therefore uses `users.search`/`articles.search`
  and omits websites/password-folders search; the manifest still projects them, because the
  runtime path honours `limit`. A missing compact overload in `src/resources/websites.ts` /
  `password_folders.ts` / `groups.ts` would fix it.
- **F5.** `listAll`/`listPages` are excluded by rule but the registry currently emits no such
  records, so the NEVER_METHODS rule is dormant (0 hits); the 22 exclusions are all binary surfaces.
- **UNVERIFIED.** Runtime behaviour of the example was not exercised against a live Hudu instance
  (no credentials); correctness rests on the SDK types (helper tier) and the typecheck. The
  `--check-example` gate reads the example statically, so it cannot detect a handler that reaches a
  primitive through an indirection defined outside the file.

## 12. Commands run

```
node scripts/project-mcp-tools.mjs                    # overrides applied=1260, primitive reads=0
node scripts/project-mcp-tools.mjs --check-example    # OK, exit 0
node scripts/project-mcp-tools.mjs --check-example --example /tmp/v-*.ts   # 7 fixtures, exit 1 each
npx tsc --noEmit                                      # 0 errors (src)
npx tsc -p /tmp/hudu-example-tsconfig.json            # 0 errors (examples/mcp-server.ts, repo options, node-hudu -> src)
```
