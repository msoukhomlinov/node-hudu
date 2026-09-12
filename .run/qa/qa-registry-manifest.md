# QA — MCP_TOOL_MANIFEST.md vs the capability registry

Branch `feat/agent-execution-layer`, HEAD `fdeec90`, working tree clean. Read-only audit.

## Answers to the two questions

**Is it a mechanical projection?** YES at the record level, NO at the revision level.
141/141 tools match the registry field-for-field (`description` = `purpose`; `inputSchema`,
`outputSchema`, `effect`, `flags`, `permissions`, `dryRun` identical; `annotations` derived
only from `effect` + `flags` + `resolution` + `pagination`). There is no per-tool hand-written
prose. BUT the file was generated from a SUPERSEDED registry: header line 4 cites
planHash `6808b158...`, generatedAt `2026-09-12T14:05:30Z`, while `capabilities.json` and
`src/capabilities.ts` both carry planHash `cd563d7f...`, generatedAt `2026-09-12T14:24:23Z`.
The manifest is therefore a projection of the registry as it stood BEFORE the helper floor
landed, not of the registry at HEAD.

**Does it obey the MCP rules?** Partly. R1, R2, R6, R7 pass. R3 fails for 38 tools,
R4 fails (no max anywhere, 8 list tools with no default), R5 passes formally but exposes a
duplicate affordance, R8 fails (overrides file absent => unreviewed, uncurated projection).

## FINDINGS (ranked)

- **CRITICAL — Manifest is a stale projection: it omits all 65 helper-tier tools and the current registry has 223 records, not 158 — `MCP_TOOL_MANIFEST.md:4,9,10` — the shipped tool list is not the registry it claims to project; an MCP client built on it never sees `resolve` / `findBy*` / `search` / `getContext`, which are the whole point of the helper floor. Re-running the same script against the current registry produces 201 tools, not 141 (223 records - 22 binary exclusions; 59 helper-tier, 85 primitive-write, 57 primitive-read) — fix: re-run `npm run mcp:project`, then add a staleness guard that compares `registry.planHash` with `CAPABILITIES_PLAN_HASH` and exits non-zero on mismatch.**

- **HIGH — "Helper-tier gaps (56 read tools with no helper backing yet)" is FALSE at HEAD — `MCP_TOOL_MANIFEST.md:30` and list `:32-87` — every one of those 56 read tools' resources now has a helper record (65 helpers in the registry); a re-run reports 0 gaps. The section would have a reviewer add helper methods that already exist. Same defect at `:21-22` ("Registry helpers are still `planned`") — no registry record carries a `status` field, so that claim is untraceable prose, and it is wrong now. Fix: regenerate; then delete the hard-coded sentence at `scripts/project-mcp-tools.mjs:184` (it cannot be derived from the registry).**

- **HIGH — Many read tools are still backed by bare primitives after the helper floor landed — `MCP_TOOL_MANIFEST.md:141,177,222,276,339,393,402,438,...` (38 tools, full list below) — this is R3: the registry names the covering helper in each helper's `related` array (`assets.resolve` related contains `assets.get`), so the mapping is mechanical, not a judgement call. Fix: back these tools with the helper record (e.g. `hudu_assets_get` -> `hudu_assets_resolve`) or record an explicit keep-the-primitive decision in `MCP_TOOL_OVERRIDES.json`.**

- **HIGH — No result bound states a max, anywhere — `MCP_TOOL_MANIFEST.md:132,186,231,285,348,456,492,537,582,627,654,735,780,870,897,987,1104,1230,1248,1374` (the 28 `bounded=` strings) — R4 requires default 10-25 AND max 100; the strings say only `page/page_size, default 25, mode page` (20 tools) or `default ?` (8 tools). `grep -n 'max' MCP_TOOL_MANIFEST.md` returns only unrelated field names (`max_wattage`, `max_width`), never a bound. The data is missing one layer down too: `pagination.maxPageSize` is `null` for all 223 registry records, and `api-docs.json` defines `page_size` with no maximum. Fix: set `maxPageSize: 100` in the plan/registry and render it; then the manifest can state the max mechanically.**

- **HIGH — The only unbounded streaming read has no bound at all — `MCP_TOOL_MANIFEST.md:357` (`hudu_assets_listAcrossCompanies`, `assets.listAcrossCompanies`, `"type":"AsyncIterable"`, "streams items one page at a time", no `bounded=`, `tier="primitive-read"`) — it scans across every company; a client that iterates it has no cap. It is also one of the 38 R3 cases (`assets.search` covers it). Fix: give it a helper backing and an explicit bound (helper scan caps are already modelled as `resolution.maxScanRecords`, e.g. `assets.resolve` = 500 records / 4 pages).**

- **MEDIUM — 8 list tools publish a placeholder bound `default ?` while their output schema claims page-by-page streaming — `MCP_TOOL_MANIFEST.md:690,825,942,1032,1149,1194,1284,1329` — the annotation says `page/page_size, default ?, endpoint is non-paginated (single page response)` but `outputSchema` is `AsyncIterable` / "streams items one page at a time". A client cannot tell what the bound is; the two statements contradict. Fix: give non-paginated list endpoints an explicit client cap instead of "default ?", or emit a single-record schema.**

- **MEDIUM — Every mutating tool exposes two dry-run inputs with the same meaning — `MCP_TOOL_MANIFEST.md:123` (`hudu_activity_logs_deleteAll`: registry `dryRun` plus the script-injected `dry_run` "Validate without issuing the write..."); same pattern on all 85 mutating tools — an LLM client sees `dryRun` and `dry_run` and may set neither or both. Fix: reuse the registry `dryRun` field or alias it instead of adding a second parameter name.**

- **MEDIUM — The `tier` computation mislabels the `procedures.getWithTasks` helper — `scripts/project-mcp-tools.mjs:50` (`HELPER_TIER_METHODS = /^(resolve|findBy[A-Za-z0-9_]*|search|getContext)$/`) — `procedures.getWithTasks` is `kind: "helper"` in the registry, so the next regeneration prints `tier="primitive-read"` for it and can inflate the helper-gap list. Fix: derive the tier from `rec.kind` instead of the method-name regex.**

- **LOW — 28 single-record read tools carry no `bounded` annotation at all — `MCP_TOOL_MANIFEST.md:141,177,222,276,339,393,402,438,528,573,618,645,681,726,771,816,933,978,1023,1086,1140,1185,1239,1275,1320,1365` — R4 as written says "every read/list tool"; these are inherently one-record reads, so the risk is low, but the rule as stated is not met. Fix: emit `bounded="single record (by id)"` for them, or scope R4 to list-shaped reads in the policy.**

- **LOW — `listAll` / `listPages` are guarded by the script but no such registry record exists, so the guard is unexercised — `scripts/project-mcp-tools.mjs:49-50` vs `capabilities.json` (0 registry names end in listAll/listPages) — the manifest simply never mentions the category is empty by construction. Fix: state in the manifest that the registry contains no `listAll`/`listPages` records (the SDK keeps them as non-registry conveniences, referenced only in `related`).**

- **NIT — The manifest advertises a curation channel that does not exist — `MCP_TOOL_MANIFEST.md:5,12,17` vs the missing `MCP_TOOL_OVERRIDES.json` — "Curation is recorded in `MCP_TOOL_OVERRIDES.json` and re-applied by the script", yet `overrides applied: 0` and no such file is present. See R8 below.**

- **R8 — `MCP_TOOL_OVERRIDES.json` is ABSENT from the project root (expected) — confirmed: `ls -la MCP_TOOL_OVERRIDES.json` -> "No such file or directory"; the stale report `.run/reports/tooling-scripts.md:86-88` also records that no repo-root overrides file exists (its override test ran in `/tmp/ovtest`). The manifest is therefore an UNREVIEWED, UNCURATED projection: lines 15-17 say tiering (core/extended) and trimming are curation, and none of it has happened; no description has been curated (`description` is the registry `purpose` verbatim) and tool names are still mechanical `hudu_<resource>_<method>`. Phase-2 deliverable missing; the §7 manifest gate (projected AND curated) is not met.**

## R3 detail — 38 read tools backed by a primitive a helper already lists in `related`

  - L141 `hudu_api_info_get` → `api_info.get` (helper: `api_info.resolve`)
  - L177 `hudu_articles_get` → `articles.get` (helper: `articles.getContext`, `articles.resolve`)
  - L186 `hudu_articles_list` → `articles.list` (helper: `articles.search`, `companies.getContext`)
  - L222 `hudu_asset_layouts_get` → `asset_layouts.get` (helper: `asset_layouts.resolve`, `assets.getContext`)
  - L231 `hudu_asset_layouts_list` → `asset_layouts.list` (helper: `asset_layouts.resolve`)
  - L276 `hudu_asset_passwords_get` → `asset_passwords.get` (helper: `asset_passwords.resolve`)
  - L285 `hudu_asset_passwords_list` → `asset_passwords.list` (helper: `asset_passwords.search`)
  - L339 `hudu_assets_get` → `assets.get` (helper: `assets.findBySerial`, `assets.getContext`, `assets.resolve`)
  - L348 `hudu_assets_list` → `assets.list` (helper: `assets.search`)
  - L357 `hudu_assets_listAcrossCompanies` → `assets.listAcrossCompanies` (helper: `assets.search`)
  - L393 `hudu_cards_jump` → `cards.jump` (helper: `cards.resolve`)
  - L402 `hudu_cards_lookup` → `cards.lookup` (helper: `cards.resolve`)
  - L438 `hudu_companies_get` → `companies.get` (helper: `companies.getContext`, `companies.resolve`)
  - L456 `hudu_companies_list` → `companies.list` (helper: `companies.search`)
  - L492 `hudu_expirations_list` → `expirations.list` (helper: `assets.getContext`)
  - L528 `hudu_flag_types_get` → `flag_types.get` (helper: `flag_types.resolve`)
  - L573 `hudu_flags_get` → `flags.get` (helper: `flags.resolve`)
  - L618 `hudu_folders_get` → `folders.get` (helper: `articles.getContext`, `folders.resolve`)
  - L627 `hudu_folders_list` → `folders.list` (helper: `folders.resolve`)
  - L645 `hudu_groups_get` → `groups.get` (helper: `groups.resolve`)
  - L654 `hudu_groups_list` → `groups.list` (helper: `groups.search`)
  - L681 `hudu_ip_addresses_get` → `ip_addresses.get` (helper: `ip_addresses.findByAddress`, `ip_addresses.resolve`)
  - L726 `hudu_label_types_get` → `label_types.get` (helper: `label_types.resolve`)
  - L771 `hudu_labels_get` → `labels.get` (helper: `labels.resolve`)
  - L816 `hudu_lists_get` → `lists.get` (helper: `lists.findByName`, `lists.resolve`)
  - L933 `hudu_networks_get` → `networks.get` (helper: `networks.resolve`)
  - L978 `hudu_password_folders_get` → `password_folders.get` (helper: `password_folders.resolve`)
  - L987 `hudu_password_folders_list` → `password_folders.list` (helper: `password_folders.search`)
  - L1023 `hudu_procedure_tasks_get` → `procedure_tasks.get` (helper: `procedure_tasks.resolve`)
  - L1086 `hudu_procedures_get` → `procedures.get` (helper: `procedures.getWithTasks`, `procedures.resolve`)
  - L1140 `hudu_rack_storage_items_get` → `rack_storage_items.get` (helper: `rack_storage_items.resolve`)
  - L1185 `hudu_rack_storages_get` → `rack_storages.get` (helper: `rack_storages.resolve`)
  - L1230 `hudu_relations_list` → `relations.list` (helper: `assets.getContext`)
  - L1239 `hudu_users_get` → `users.get` (helper: `users.findByEmail`, `users.resolve`)
  - L1275 `hudu_vlan_zones_get` → `vlan_zones.get` (helper: `vlan_zones.resolve`)
  - L1320 `hudu_vlans_get` → `vlans.get` (helper: `vlans.resolve`)
  - L1365 `hudu_websites_get` → `websites.get` (helper: `websites.resolve`)
  - L1374 `hudu_websites_list` → `websites.list` (helper: `companies.getContext`, `websites.search`)

(The remaining 18 read tools are `*.list` ops whose only same-resource helpers are `resolve`/`findBy*`
— e.g. `activity_logs.list`, `flag_types.list`, `users.list`. Those are defensible as primitives;
they still need bounds, see the R4 findings.)

## VERIFIED OK

- **R1 — every tool's `backingOperation` is a real registry record.** Check: parsed all 141
  `### <tool>` blocks and compared `backingOperation` against `capabilities.json`
  `operations[].name` (223 records) and against the `src/capabilities.ts` registry keys
  (223 keys under `CAPABILITY_REGISTRY = {`).
  Result: **0 missing** on both; manifest ops not in ts = `[]`, ts keys not in capabilities.json = `[]`.
- **R2 — no tool is backed by `*.listAll` / `*.listPages`.** Check: registry names ending in
  listAll/listPages = `[]`; no manifest `backingOperation` ends in `listAll`/`listPages`.
  Result: **0 violations**. `listAll`/`listPages` appear in the registry only inside `related` arrays.
- **R4 numbers as found (actual values):** `default 25` on 20 list tools
  (L132,186,231,285,348,456,492,537,582,627,654,735,780,870,897,987,1104,1230,1248,1374);
  `default ?` on 8 (L690,825,942,1032,1149,1194,1284,1329); **max: absent on all 28**;
  registry `pagination.maxPageSize` = `null` for all 223 records; `api-docs.json` `page_size` has no maximum.
- **R5 — all 85 mutating tools expose a dry-run affordance.** Check: 85 tools with
  `effect` in (write, destructive); 85/85 carry `dryRunAffordance="dry_run"` and `dryRun: true`.
  Result: **0 missing** (the duplicate-name defect is listed above).
- **R6 — sensitive / requiresApproval are annotated on every projected tool.** Check: 12 tools
  `sensitive=true` (L249,258,267,276,285,294,303,960,969,978,987,996), each also carrying
  `sensitiveNotice`; 27 tools `requiresApproval=true` (e.g. L123,168,267,330,429,483).
  Cross-check against registry `flags` for all 141 tools: **0 mismatches**. The 2 registry
  `requiresApproval` ops not projected (`photos.delete`, `uploads.delete`) and the 5 registry
  `sensitive` records not projected (`asset_passwords.findBySlug|resolve|search`,
  `password_folders.resolve|search`) are excluded-binary / helper records — that is the
  staleness finding, not an annotation error.
- **R7 — no binary or download tool exists.** Check: projected resources intersected with
  (photos, public_photos, uploads, exports, s3_exports) = empty set; `specialOp` is `null` for all
  223 registry records (no `download` special op exists to project); the 17 binary exclusions are
  tabulated at `MCP_TOOL_MANIFEST.md:99-119`.
- **Mechanical field equality, 141/141.** Check: programmatic diff of every tool block against the
  registry record. `description` == `purpose`: 141/141 identical. `outputSchema`, `effect`, `flags`,
  `permissions`, `dryRun`, `sensitive`, `requiresApproval`: **0 mismatches**. `inputSchema`: identical
  except the script-injected `dry_run` on exactly the 85 mutating tools. The JSON block
  (`MCP_TOOL_MANIFEST.md:1394-1538`, 141 entries) contains only registry-traceable keys
  (`name`, `backingOperation`, `description`, `inputSchema`, `outputSchema`, `effect`, `flags`,
  `permissions`, `dryRun`, `compact`, `errors`) plus the derived `annotations` (11 keys).
- **No hand-written per-tool prose.** The only prose not traceable to a registry field is
  template-level, in `scripts/project-mcp-tools.mjs`: the header (`:163-166`), the rules list
  (`:177-186`, including the false "Registry helpers are still `planned`" at `:184`), the summary
  (`:169-175`) and "Curation still owed" (`:196-198`).
- **12+ tool sample, cited by line** (effect / tier / bound / dry-run / sensitivity):
  L123 `hudu_activity_logs_deleteAll` destructive, primitive-write, requiresApproval=true, dry_run;
  L132 `hudu_activity_logs_list` read, bounded default 25;
  L141 `hudu_api_info_get` read, no bound, helper `api_info.resolve` exists;
  L276 `hudu_asset_passwords_get` read, sensitive=true, no bound;
  L357 `hudu_assets_listAcrossCompanies` read, AsyncIterable, no bound;
  L483 `hudu_expirations_delete` destructive, requiresApproval=true, dry_run;
  L690 `hudu_ip_addresses_list` read, bound `default ?`;
  L978 `hudu_password_folders_get` read, sensitive=true, no bound;
  L1194 `hudu_rack_storages_list` read, AsyncIterable vs "non-paginated" bound;
  L1248 `hudu_users_list` read, bounded default 25, helpers `users.resolve`/`users.search` exist;
  L1374 `hudu_websites_list` read, bounded default 25;
  L1383 `hudu_websites_update` write, dry_run, dryRun=true;
  L1086 `hudu_procedures_get` read, no bound, helpers `procedures.resolve`/`procedures.getWithTasks` exist;
  L339 `hudu_assets_get` read, no bound, helpers `assets.resolve`/`findBySerial`/`getContext` exist.

## METHOD

- `git branch --show-current` -> `feat/agent-execution-layer`; `git status --porcelain` -> clean.
- Parsed `MCP_TOOL_MANIFEST.md` (1539 lines) into 141 tool blocks plus the JSON block; parsed
  `capabilities.json` (223 operations: 158 primitive / 65 helper), `capabilities.plan.json`
  (225 rows: 223 `tested`, 2 `planned`), `src/capabilities.ts`, `scripts/project-mcp-tools.mjs`.
- Simulated the script's projection logic in Python against the current registry (the script was
  NOT executed — it writes to the repo). Result: 201 tools / 22 exclusions / 0 helper gaps.
- No repo writes were made. Only this findings file was written.
