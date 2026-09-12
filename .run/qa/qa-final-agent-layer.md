# QA — FINAL AGENT LAYER REVIEW (api-node-squad 3.0.1, last gate)

Branch: `feat/agent-execution-layer` @ `ca011f16a0e26feb0214bcb5e73e074c6dba12a7` (verified with `git rev-parse HEAD`).
Baseline: `main` @ `9332efe` (v0.2.1). 28 commits `main..HEAD`. 163 files, +62018/-368.
Reviewer: final agent-layer layer. Read-only; only this file was created.
Budget used: ~44 grounding calls.

## Method and falsification (a clean verdict from one lens is one lens)

All gate/test runs were done in a CLEAN copy of the commit (`git archive HEAD | tar -x -C /tmp/qaF/wt`,
`node_modules` symlinked), never in the working tree, so the in-flight regeneration could not tint the result.
I attacked the code, not the reports: I wrote my own runtime probes (id miss, complete scan, cap, ambiguity,
limit bounds, compact/expand, primitives, page-2) against the public `HuduClient` surface, machine-compared
every registry schema against the TypeScript sources, and tampered with copies of the manifest to test the gate.

## Working-tree note (out of scope, recorded not reported)

`MCP_TOOL_MANIFEST.md`, `examples/mcp-server.ts` AND `scripts/project-mcp-tools.mjs` all carry uncommitted
modifications (the regenerating agent), and `MCP_TOOL_OVERRIDES.json` is UNTRACKED. The working-tree manifest is
complete and self-consistent (118 helper-tier, 0 gaps, 1260 overrides, planHash `65c7cab6…`) — not half-written —
but it is not part of `ca011f1`. Skipped as a defect per the brief; it is the basis of finding F1.

## Re-verification of the 14 earlier findings

1. **HIGH manifest stale — CLOSED.** Committed manifest header pins planHash `65c7cab6…`, which equals
   `capabilities.json`'s planHash, and claims 225 registry records, which equals the registry's 225. A fresh run of
   the committed script in the clean copy reproduces the committed manifest byte-for-byte except the
   `projection timestamp` line (2176 lines, 1 diff). The `manifest-planhash` rule now exists and I falsified it two
   ways: a `/tmp` copy with a tampered planHash → exit 1 `[manifest-planhash] stale`, and a copy claiming 158
   records → exit 1 `[manifest-planhash] record count`. Residual class that the rule cannot catch → F1.
2. **HIGH opaque inputSchema for 11 helpers — CLOSED.** The 11 named helpers now expose concrete fields
   (`limit`/`expand`/`company_id`/`resolutionDetails`/`allowClientScan`/`identifier`); `relations.findByEndpoints`
   now carries `from`/`to` objects (`type`+`id`) plus `opts(limit,expand,isInverse)` instead of the flattened inner
   keys — `src/capabilities.ts` (`relations.findByEndpoints`), the earlier-opaque ones at `articles.search`,
   `assets.search`, `asset_passwords.search`, `relations.resolve`, `users.search`, `cards.resolve`,
   `matchers.resolve`, `flags.resolve`, `flag_types.resolve`, `rack_storage_items.resolve`. A scan of all 225
   records finds only 4 `type:"union"` opts nodes, and every one carries `variants` with full `fields`
   (`HelperOptions` / `ResolutionOptions`), i.e. 0 opaque. Sampled 2 helpers per group (A `articles.findBySlug`,
   `articles.getContext`; B `flag_types.resolve`, `flags.findByFlagable`; C `activity_logs.findByResource`,
   `activity_logs.resolve`; D `exports.resolve`, `label_types.resolve`) plus both operations helpers: all concrete.
3. **HIGH WebsiteSummary projection lie — CLOSED.** `src/resources/websites.ts:toWebsiteSummary` populates all 10
   declared fields; runtime probe: `websites.resolve(7)` returns exactly
   `{archived,company_id,company_name,id,monitoring_status,name,paused,slug,status,url}` with real values, and
   `websites.resolve(7,{expand:true})` returns the full record (`code`,`headers`,`notes`,`updated_at` present).
   Registry `outputSchema.fields` equals the declared interface field set for all 35 compact shapes (machine
   comparison, 0 mismatches); `drops` = full-record minus kept (21 fields for `WebsiteSummary`); 0 records with
   `dropsUnresolved`. The new test would fail if a field were dropped:
   `test/resources/websites.test.ts` ("populates every field the WebsiteSummary interface declares, in every
   helper") builds a SENTINEL map and asserts `declaredSummaryFields('<types/website.ts>','WebsiteSummary')`
   equals its keys, so a widening without a projection change fails.
4. **MEDIUM registry over-declares scans / RESOLUTION_* — PARTLY CLOSED, still open for 2 rows**
   (see F2). `api_info.resolve`, `uploads.resolve`, `rack_storage_items.resolve`, `flags.resolve` now have
   `resolution: null` and no `RESOLUTION_*` codes.
5. **MEDIUM asset_layouts reads one page and returns a silent null — CLOSED.** `filterScan` now walks pages through
   `boundedScan` with a learned full-page size (`hasMore: items.length === fullPage`, grown when the server returns
   a longer page), refuses `limit` with `CONFIG_ERROR`, and throws `RESOLUTION_TRUNCATED` when the cap stops the
   walk — `src/resources/asset_layouts.ts` (`filterScan`, `assetLayoutPages`). Tests cover the page-2 find, the
   4-page truncation, page-size learning (40 > 25) and `scanned: 26`. My independent probe reproduced page-2
   discovery with no `page_size` in any request URL.
6. **MEDIUM helper options silently ignored — CLOSED for `articles.getContext` and `asset_layouts.resolve`**
   (`articles.getContext` no longer takes `limit` and documents why; `asset_layouts.resolve` refuses `limit` with
   `CONFIG_ERROR`). Narrowed residual for `users.search` → F3.
7. **LOW `scanned` 0 vs 1 — STILL OPEN.** `src/resources/websites.ts`, `groups.ts`, `folders.ts`,
   `password_folders.ts` report `scanned: 0` for a direct id fetch; ~25 others report 1. Runtime:
   `websites.resolve(7,{resolutionDetails:true}).scanned === 0` but `companies.resolve(42,…).scanned === 1`.
8. **LOW two codes for an unsupported identifier kind — STILL OPEN.** `identifierError` → `CONFIG_ERROR`
   (`agent-layer-helpers.ts:41`, used by cards/companies/articles/assets/matchers/activity_logs/expirations/
   public_photos) vs local `unsupported*Identifier` → `VALIDATION_FAILED` (`networks.ts:41`, `vlan_zones.ts:37`,
   `ip_addresses.ts`, `vlans.ts`, `rack_storages.ts`). Both `category: validation`.
9. **LOW 13 copies of the limit policy — STILL OPEN.** `agent-layer-helpers.ts` exports `helperLimit(limit, method)`
   (imported by `cards.ts`, `activity_logs.ts`, `expirations.ts`, `matchers.ts`, `operations.ts`) while 12 resource
   files still declare a local `helperLimit` (e.g. `companies.ts:59`, single-arg). Behaviour is identical
   (25 default / 100 max / throws), so this is drift risk only.
10. **LOW 66 `unplanned-surface` warnings — STILL OPEN (now 67).** `node scripts/check-capabilities.mjs`:
    66 `[unplanned-surface]` (33 × `listAll`/`listPages`, present on `main` too, non-blocking) + 1 new
    `[resolution-basis]` for `procedures.getWithTasks` (`basis "composite"` is neither `server-filter` nor
    `client-scan`, and the rule is warning-only; the vocabulary in the script header does not list it).
11. **NIT `procedures.getWithTasks` scan metadata — STILL OPEN, now surfaced as a warning.** Its registry record
    carries `resolution {basis:'composite', maxScanRecords:500, maxScanPages:4}` and
    `RESOLUTION_AMBIGUOUS`/`RESOLUTION_TRUNCATED` for a two-call composite read.
12. **NIT limit default/max not machine-readable — STILL OPEN.** 0 of 225 records carry `default` or `maximum` on a
    `limit` field; the bound lives in the prose `usage` only.
13. **NIT `users.resolve` missing the both-flags overload — CONFIRMED, restated.** `tsc` inference:
    `users.resolve(x,{expand:true,resolutionDetails:true})` → `User | UserSummary | Resolution<UserSummary> | null`
    vs `websites.resolve` → `Resolution<Website>`. The runtime returns a `Resolution` whose `value` is the full
    `User`, so the union's `Resolution<UserSummary>` member mis-types `.value`.
14. **NIT `companies.jump` `NOT_ACCEPTABLE` without a per-operation row — STILL OPEN.** 406 is asserted only by the
    central mapping test (`test/core-agent-layer.test.ts:816,861`); no `companies.test.ts` row names it, while the
    registry lists `NOT_ACCEPTABLE` for `companies.jump`.

## Findings (ranked)

- **MEDIUM — the release commits a pre-curation MCP surface and does not track the curation file.**
  `MCP_TOOL_MANIFEST.md:1-30` (committed at `ca011f1`) says "overrides applied: 0 (no MCP_TOOL_OVERRIDES.json
  present)" and "59 read tools are still backed by a plain primitive (57 have a helper-tier alternative in the
  registry)"; `MCP_TOOL_OVERRIDES.json` is untracked (`git ls-files` empty, `git status` shows `??`), and the
  header of the committed manifest already points consumers at that file. Why it matters: MCP is the declared
  primary use case (SCOPING A/J), rule 1 of the projection requires every read tool be helper-backed, and the
  `manifest-planhash` gate checks only planHash + record count — I verified a manifest with both correct still
  passes (the committed one does). Suggested fix: commit the regenerated `MCP_TOOL_MANIFEST.md` **with**
  `MCP_TOOL_OVERRIDES.json` (and the updated `scripts/project-mcp-tools.mjs`) before tagging, or the tag ships a
  manifest that contradicts itself.

- **LOW — `activity_logs.findByResource` and `flags.findByFlagable` declare `RESOLUTION_TRUNCATED` they cannot
  throw.** `src/resources/activity_logs.ts` (`collectBounded` discards `boundedScan`'s `scanTruncated` and returns
  `items.slice(0, limit)`); `src/resources/flags.ts` (`findByFlagable` reads exactly ONE page, no scan at all);
  both published in `src/capabilities.ts` / `capabilities.json` with
  `resolution {basis:'server-filter', maxScanRecords:500, maxScanPages:4}` and `RESOLUTION_TRUNCATED`. Runtime
  probes with `capped(25,2)` against a 25-row page returned rows normally for both, and `test/resources/flags.test.ts`
  never asserts the code. Why it matters: SCOPING decision 2 ("codes the SDK actually throws") and §11 ("test every
  error code the registry documents") are both unmet for these two rows; an agent branches on a signal that never
  arrives. Suggested fix: drop `RESOLUTION_TRUNCATED` from both rows (keep the caps only where a truncation is real),
  or make the two helpers report truncation.

- **LOW — `users.search` advertises and accepts `resolutionDetails` then silently ignores it.**
  `UsersSearchOptions extends HelperOptions` (`src/resources/users.ts:27-30`, `resolutionDetails` at
  `src/types/common.ts:152`), the registry record advertises it, and `search` reads only
  `limit`/`archived`/`security_level`/`expand` (`src/resources/users.ts:239-248`) — a caller asking for a
  `Resolution` gets a bare array with no error. Why it matters: it is the exact silent no-op the SDK now refuses
  elsewhere (`asset_layouts.resolve` throws `CONFIG_ERROR` for a `limit` it cannot honour), and `articles.search`
  is honest by contrast (`ArticleSearchOptions` has no `resolutionDetails`). Suggested fix: declare
  `UsersSearchOptions` without `HelperOptions` (or reject the option), then regenerate.

- **LOW — the committed projection script misclassifies the two operations helpers as unbacked reads.**
  `scripts/project-mcp-tools.mjs` (committed) classifies by the regex `^(resolve|findBy[A-Za-z0-9_]*|search|getContext)$`,
  which does not match `resolveAny` / `searchAcrossResources`, so a run prints "read tools missing helper-tier
  backing: 2 (hudu_operations_resolveAny, hudu_operations_searchAcrossResources)" although both are `kind: "helper"`
  registry records, and they land in the "read primitives" worklist. Why it matters: §7 rule 1 is reported violated
  twice, in a manifest that is the consumer-facing tool list. The working-tree script already adds registry-kind
  classification plus a `mislabelled` report — in flight, so not scored as a defect; it must land with F1.

- **LOW — the declared-interface widening guard exists in only 4 of 35 compact shapes.**
  `declaredSummaryFields` appears in `test/resources/{websites,groups,folders,password_folders}.test.ts` — the four
  summaries that were widened during the fix. The other 31 shapes are pinned by example literals only. Why it
  matters: the HIGH #3 class (a summary widened, projection not updated) can recur silently for any of the 31.
  Suggested fix: generalise the sentinel-vs-interface test into one table-driven spec over every compact shape.

- **LOW — `operations.resolveAny` carries a compact shape with no `expand`, alone among 60.**
  `capabilities.json` (`operations.resolveAny`: `compact: "ResolutionCandidateHit"`, opts `resources`,`limit`);
  the other 59 compact-bearing helpers expose `expand: true` (§9). Defensible because its hits are cross-resource
  candidates, not record summaries — flagging it so the asymmetry is a recorded decision, not an accident.

- **NIT — `outputSchema` has 3 unresolved generic nodes, all in the two operations helpers.**
  `capabilities.json` `operations[139].outputSchema.fields[0]` → `R`, `operations[140].outputSchema.fields[0]` → `R`
  and `[3]` → `SearchableSummaryMap[R]` (nodes with `"resolved": false`). Why it matters: a projection or an MCP
  client cannot describe those response shapes. Suggested fix: emit the concrete union of hit shapes for the two
  helpers instead of the generic parameter.

- **NIT — `CHANGELOG.md:9` dates 0.3.0 to 2026-09-13, one day after the current date (2026-09-12).** Cosmetic, but
  it is the first line a consumer reads; correct it if the release is not actually dated tomorrow.

## VERIFIED OK (command → result)

- `git rev-parse HEAD` → `ca011f16a0e26feb0214bcb5e73e074c6dba12a7`; `git log --oneline main..HEAD | wc -l` → 28;
  `git diff main...HEAD --stat` → 163 files, +62018/-368.
- `node scripts/check-capabilities.mjs` → `PASS — 0 failures; rows=225 scoped=225 registryRecords=225 warnings=67`,
  exit 0. `--ship` → exit 0 PASS. `--group A|B|C|D` → exit 0, scoped 77/57/42/47. All in the clean copy.
- `node scripts/check-capabilities.mjs --plan test/fixtures/capabilities.plan.drifted.json` → **exit 1**
  (`missing-key=1, mutation-dryRun=1, test-title=1`).
- `node scripts/check-capabilities.mjs --manifest /tmp/qaF/stale-hash.md` → **exit 1**; `--manifest
  /tmp/qaF/stale-count.md` → **exit 1**; `--manifest <committed copy>` → PASS. Both tampered copies name
  `[manifest-planhash]` with the offending value.
- `npx tsc --noEmit` (clean copy) → exit 0, no output.
- `npx vitest run` (clean copy) → **49 test files passed, 1500 tests passed**, 2.42 s.
- `node scripts/project-mcp-tools.mjs` (clean copy) → exit 0; regenerated manifest equals the committed file except
  the `projection timestamp` line; `--check-example` → exit 0.
- Registry machine checks: 225 records (158 primitive / 67 helper). Helper floor: `resolve` on 34/35 resources plus
  `api_info`'s documented degenerate case; `s3_exports` has no helper and no `resolve` (SCOPING decision 14).
  Helpers beyond the floor per resource = **0**, so the §5 soft cap (2–4 beyond floor) is met everywhere —
  `companies`' 5 helpers are `resolve` + 2 `findBy` + `search` + `getContext`, all floor. `compact` is set on
  helpers only (0 of 158 primitives). `outputSchema.fields` == declared interface fields for all 35 compact shapes
  (0 mismatches). `dropsUnresolved` count 0. Primitives carry no `resolution` (0 of 158).
- Runtime probes (my own, clean copy, mocked fetch): `{id}` miss → `NOT_FOUND`; complete empty scan → `null`;
  `capped(25,2)` against a full page → `RESOLUTION_TRUNCATED` (same for `capped(10,4)`); two exact matches →
  `RESOLUTION_AMBIGUOUS` with `resourceIds: [11,12]`; `limit 101` and `limit 0` → `CONFIG_ERROR`, `limit 25` OK;
  `assetLayouts.resolve('l',{limit:25})` → `CONFIG_ERROR`; `websites.resolve(7)` → the 10 declared compact fields
  with real values; `expand: true` → full record; `companies.get(42)` keys ⊇ `companies.resolve(42)` keys
  (primitives stay complete); `assetLayouts.resolve('second')` finds a layout on page 2 with no `page_size` sent.
- `SCOPING.md` carries exactly 14 numbered decisions (`grep -cE '^[0-9]+\. \*\*' SCOPING.md` → 14);
  `package.json` version `0.3.0`; `CHANGELOG.md` has the 0.3.0 section; `README.md` has the agent-helpers section;
  `docs/API.md` 1089 lines.
- Artefacts present and internally consistent: `capabilities.json` (225 ops), `capabilities.schema.json`,
  `src/capabilities.ts` (225 records), `capabilities.plan.json` (225 rows, all `tested`), `MCP_TOOL_MANIFEST.md`.

## UNVERIFIED

- **`getContext` sub-list bounding at runtime** — my probe's stub could not satisfy the company-scoped assets
  envelope, so this rests on the code (`page_size: size` + `take(…, size)` in
  `src/resources/companies.ts:330-350`, `src/resources/assets.ts` getContext) and on the repo's passing tests, not
  on my own runtime probe.
- **Live-vendor behaviour** — page-size learning, `hasMore` and vendor-filter claims are checked against the local
  `api-docs.json` spec, never a live Hudu instance.
- **The regenerated working-tree artefacts** (`MCP_TOOL_MANIFEST.md`, `examples/mcp-server.ts`,
  `scripts/project-mcp-tools.mjs`, `MCP_TOOL_OVERRIDES.json`) — out of scope per the brief; F1 is about their
  absence from `ca011f1`, not about their content.
- **Coverage (99.65/99.89/92.49/99.27) and `npm pack` install proof** — taken from the brief; I ran the full test
  suite in a clean copy instead, so I did not re-measure coverage or the packed tarball.
- **Intent of the new `resolution-basis` warning** — whether `basis: "composite"` is an approved exception for
  `procedures.getWithTasks`; the accommodation runbook does not define a third basis, and the gate tolerates it as
  a warning without a recorded decision.
- **`public_photos.resolve` ambiguity** (a record with several public photos) — no test and no runtime probe.

## Verdict

**No CRITICAL or HIGH defect in the committed code state.** The three HIGH findings I raised earlier are closed and
proven closed by code, schema and runtime evidence, and the gate/tests pass in a clean checkout of the commit
(`check-capabilities` 0 failures, `--ship` PASS, drifted fixture exit 1, `tsc` exit 0, 1500 tests pass).

**One release-hygiene blocker:** the commit ships a pre-curation MCP surface (`MCP_TOOL_MANIFEST.md` stating 0
overrides and 59 primitive-backed read tools) while `MCP_TOOL_OVERRIDES.json` is untracked, and no gate rule can
see that class of staleness. Commit the regenerated manifest together with the overrides file and the updated
projection script, or do not tag `ca011f1`.

Everything else is LOW/NIT debt on an otherwise honest surface: 2 registry rows declare a truncation code they
cannot throw, one helper advertises an option it ignores, one projection-script regex misclassifies 2 helpers,
the widening guard covers 4 of 35 shapes, `scanned` is inconsistent on 4 resources, and the identifier-kind code
differs between two file families.
