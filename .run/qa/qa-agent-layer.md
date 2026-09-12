# QA — AGENT EXECUTION LAYER (independent second lens)

Reviewer: agent-layer reviewer (read-only, different model family from the coordinator/implementers).
Branch `feat/agent-execution-layer`; "additive" baseline `main` @ `9332efe`.
Policy: `~/.prime/agent/skills/api-node-squad/references/agent-execution-layer.md` §4.1/§5/§6/§9/§11;
SCOPING.md decisions 2, 6, 7, 8, 10, 13, 14; runbook Phase F.
Scope note: `src/operations/**` (the 2 `operations.*` helper rows) is STILL ABSENT at this revision and is
treated as out of scope per the brief — it is the concurrent implementer's path.

## Findings (ranked by severity)

- **HIGH — `MCP_TOOL_MANIFEST.md` is stale: it describes the pre-helper registry and was never regenerated.**
  `MCP_TOOL_MANIFEST.md:4` pins `planHash 6808b158…`, `generatedAt 2026-09-12T14:05:30.656Z`; the shipped
  registry is `planHash cd563d7f…`, `generatedAt 14:24:23.778Z` (`capabilities.json:2-3`, `src/capabilities.ts:1-6`).
  Line 9 says "registry records: 158" (actual 223), line 22 says "Registry helpers are still `planned`, so read
  coverage is not yet complete", and line 30 heads "Helper-tier gaps (56 read tools with no helper backing yet)".
  Why it matters: MCP is the declared primary use case (SCOPING A, decision J), so this file is the consumer-facing
  tool surface, and it currently tells a server builder that no helper exists and that 56 read tools are unbacked —
  the opposite of the shipped truth. `scripts/check-capabilities.mjs` validates the *emission* planHash but never the
  manifest's, which is why the gate stays green.
  Fix: re-run `npm run mcp:project` after the last `capabilities:build`, and add a `manifest-planhash` rule to
  `check-capabilities.mjs` that compares `MCP_TOOL_MANIFEST.md:4` with the registry planHash.

- **HIGH — registry `inputSchema` is wrong or opaque for 11 of 65 helpers (tool-generator contract).**
  `src/capabilities.ts` records: `articles.search`, `assets.search`, `asset_passwords.search`, `relations.resolve`
  expose a single opaque `"opts": {"type":"union","anyOf":["object","object"]}` and no real parameters — the code
  takes `opts?: HelperOptions & { company_id?: number }` (e.g. `src/resources/articles.ts:213-231`,
  `src/resources/assets.ts:328-352`); `users.search` exposes only `[archived, query, security_level]` although
  `UsersSearchOptions extends HelperOptions` and the code honours `limit`/`expand`
  (`src/resources/users.ts:27-30, 236-248`); `cards.resolve` and `matchers.resolve` expose
  `[allowClientScan, identifier]` and drop `limit`/`expand`/`resolutionDetails` that the code does accept
  (`src/resources/cards.ts:78-95` calls `helperLimit(opts?.limit, method)`); `relations.findByEndpoints` exposes
  `[expand, id, isInverse, limit, type]`, i.e. the `from`/`to` endpoint objects were *flattened into their inner
  keys*, so the schema does not match `findByEndpoints(from, to, opts)` at all (`src/resources/relations.ts:274-305`);
  `flags.resolve`, `flag_types.resolve`, `rack_storage_items.resolve` also carry the opaque `opts`.
  Why it matters: `scripts/project-mcp-tools.mjs` reads exactly these schemas, so a generated MCP tool cannot pass
  `limit`, `company_id`, `expand` or the endpoint pair — the agent-facing inputs the policy §9/§11.7 require.
  The gate passes because it only checks that `drops` is present for compact shapes (check-capabilities.mjs:352-360).
  Fix: derive helper inputs from the implementation signature/option bags (or assert in the generator that no
  helper inputSchema contains `opts`, `anyOf` of two objects, or a flattened sub-object).

- **HIGH — the `websites` compact shape lies in both directions; it drops the field callers resolve by.**
  `toWebsiteSummary` (`src/resources/websites.ts:50-59`) returns exactly `{id, name, company_id, monitoring_status,
  paused, archived}`, but `WebsiteSummary` (`src/types/website.ts:66-77`) and the registry record
  (`src/capabilities.ts`, `websites.resolve` / `websites.findBySlug` / `websites.search`) declare `slug`,
  `company_name`, `status` and `url` as *kept* fields and omit them from `drops`. So the registry tells an agent
  that `slug` survives, while `websites.resolve('acme')` / `websites.findBySlug('acme')` hand back a summary with
  `slug: undefined` — and slug is the very field those helpers resolve by (§9 "compact shapes never drop the field a
  caller resolves by", SCOPING decision 6). The test asserts the *code* (test/resources/websites.test.ts:243-255
  pins `['archived','company_id','id','monitoring_status','name','paused']`), so the registry is the wrong side.
  Fix: either mark `slug`/`company_name`/`status`/`url` optional-and-absent in `WebsiteSummary` and list them in
  `drops`, or populate them in `toWebsiteSummary`.

- **MEDIUM — the registry claims scans (and RESOLUTION_TRUNCATED / RESOLUTION_AMBIGUOUS) for helpers that can never scan.**
  Violates SCOPING decision 2 ("the registry `errors` column lists the codes the SDK **actually throws** … a registry
  that names codes the codebase never throws produces test rows that cannot be written") and §6 ("the scan capability
  is recorded in the registry under `resolution`").
  Evidence (code read, not inferred): `api_info.resolve` is `await this.get()` only (`src/resources/api_info.ts:29-42`);
  `uploads.resolve` is `this.getOne<Upload>(id)` only (`src/resources/uploads.ts:97-115`); `rack_storage_items.resolve`
  is `getByIdOrThrowMissing` → `getOne` only (`src/resources/rack_storage_items.ts:183-215`); `flags.resolve` is
  `getOne` only (`src/resources/flags.ts:195-222`); `asset_layouts.filterScan` can never return `scanTruncated`
  (`src/resources/asset_layouts.ts:206-228`). All five nevertheless publish
  `"resolution":{"basis":"server-filter","maxScanRecords":500,"maxScanPages":4}` and
  `errors:[…,"RESOLUTION_AMBIGUOUS","RESOLUTION_TRUNCATED"]`. The same over-declaration hits the two list helpers
  `activity_logs.findByResource` and `flags.findByFlagable` (they return rows, never a `Resolution`).
  Why it matters: an agent that reads the registry will (a) expect a cost/truncation signal that never arrives and
  (b) branch on codes that cannot be thrown; and §11's "test every error code the registry documents" is unsatisfiable
  for those rows — `test/resources/uploads.test.ts` and `test/resources/api_info.test.ts` indeed never mention them.
  Fix: set `resolution: null` and drop `RESOLUTION_*` from those plan rows, then regenerate.

- **MEDIUM — `asset_layouts.resolve` reads ONE page of a paginated endpoint and calls it complete, so a real match can become a silent `null` and the declared truncation path is unreachable.**
  `src/resources/asset_layouts.ts:210-228`: the scan fetcher returns `hasMore: false` and `page_size: items.length`
  for page 1 only (`/asset_layouts` accepts `page` but not `page_size` — and the same file's `assetLayoutPages`
  walks pages with a learned page size, `src/resources/asset_layouts.ts:271-320`, so the author knew one page is not
  the whole set). Consequence: if the matching layout sits on page 2 of the server's own paging, `resolve` returns
  `null` ("a complete scan found nothing") instead of `RESOLUTION_TRUNCATED`; the registry advertises
  `maxScanPages: 4` and the code comment promises "a capped scan would throw RESOLUTION_TRUNCATED"
  (`src/resources/asset_layouts.ts:135-136`). Fix: drive the scan through `assetLayoutPages` (page-aware `hasMore`)
  so the cap/truncation contract is real.

- **MEDIUM — helper options that are silently ignored (the SDK refuses silent no-ops everywhere else).**
  `articles.getContext(id, { limit })` advertises `limit` in its type (`src/resources/articles.ts:238-242`) and in the
  registry `inputSchema`, but the body never reads it (it returns one article + company + folder, no sub-lists;
  `src/resources/articles.ts:242-254`) and never calls `helperLimit`. Likewise every `search` helper accepts
  `resolutionDetails` through `HelperOptions` (`src/types/common.ts:127-134`) and ignores it, while the registry
  advertises it as an input for `companies.search`, `groups.search`, `websites.search` — a caller asking for
  `Resolution<T>` gets a bare array with no error (`src/resources/companies.ts:281-298`). Compare the mutation path,
  which explicitly throws for options that would be a silent no-op (`src/resources/base.ts`, "Mutation options must be
  the 4th argument", `assertNoExpectedUpdatedAt`). Fix: reject an option a helper does not implement, or drop it from
  the signature + registry.

- **LOW — direct-fetch `scanned` is inconsistent (0 vs 1).**
  `scanned: 0` for a direct id fetch in `src/resources/websites.ts:312`, `src/resources/folders.ts:270`,
  `src/resources/groups.ts:244`, `src/resources/password_folders.ts:307`; `scanned: 1` in ~25 others
  (e.g. `src/resources/companies.ts:371`, `src/resources/lists.ts:143`). An agent comparing `Resolution.scanned`
  across resources gets contradictory answers. Pick one (1 reads better: one record was examined).

- **LOW — the same caller error carries two different codes.**
  An unsupported identifier kind throws `CONFIG_ERROR` via `identifierError` (`src/resources/agent-layer-helpers.ts:47-51`,
  used by `cards`, `companies`, `articles`, `assets`, `public_photos`) but `VALIDATION_FAILED` via the local
  `unsupported*Identifier` helpers (`src/resources/networks.ts`, `ip_addresses.ts`, `vlans.ts`, `vlan_zones.ts`,
  `rack_storages.ts`). Both are `category: "validation"` so the §8 decision mapping still works, but a caller cannot
  branch on `code` alone. Align on one code for the "kind not supported" case.

- **LOW — the shared helper module is not shared: the limit policy has 13 copies.**
  `src/resources/agent-layer-helpers.ts` (default 25 / max 100, throws) is imported by 7 files, while
  `companies.ts:28-40`, `assets.ts:17-25`, `websites.ts:24-33`, `groups.ts:18-25`, `users.ts:33-45`, `labels.ts:26-…`,
  `flags.ts:55-…`, `relations.ts:58-…`, `photos.ts:44-…`, `password_folders.ts:28-…`, `asset_passwords.ts:18-…`,
  `asset_layouts.ts:16-27` each re-declare `DEFAULT_HELPER_LIMIT`/`MAX_HELPER_LIMIT`/`helperLimit`. Behaviour is
  currently identical everywhere (verified: all throw above 100, none clamp), so this is drift risk, not a defect.

- **LOW — 66 gate warnings: pre-existing `listAll`/`listPages` are in neither the plan nor the registry.**
  `node scripts/check-capabilities.mjs` prints 66 `[unplanned-surface]` warnings (all 33 resources × 2). They exist on
  `main` too (`git show main:src/resources/companies.ts` line 36/62), so this is not a regression — but §4.1
  ("one record per operation the SDK actually implements") is unmet for 66 public methods and the gate reports them as
  non-blocking warnings only.

- **NIT — `procedures.getWithTasks` carries scan metadata it does not have.**
  `src/capabilities.ts` record for `procedures.getWithTasks`: `errors: [CONFIG_ERROR, NETWORK_ERROR,
  RESOLUTION_AMBIGUOUS, RESOLUTION_TRUNCATED]`, `resolution: {basis:'composite', …}`, `retry.idempotencySupport:'none'`
  — the helper is a two-call composite read (`src/resources/procedures.ts:288-308`) that resolves and rethrows nothing
  from that list. Same generator-template issue as the MEDIUM above.

- **NIT — `limit`'s default (25) and hard max (100) are not machine-readable.**
  Registry `inputSchema.limit` is `{name, type, required}` with no `default`/`maximum`; the bound is documented in prose
  only (`usage`: "limit defaults to 25, max 100"). Behaviour is correct (throws above 100, SCOPING-compliant), but a
  generated MCP tool schema cannot express the constraint.

- **NIT — `users.resolve` has no `{expand:true, resolutionDetails:true}` overload while the runtime returns the full record.**
  `src/resources/users.ts` (`resolve`, resolutionDetails branch) returns `found` — a `Resolution<User>` — when both
  flags are set, but the visible type is `Resolution<UserSummary>`; `websites`/`folders` declare the both-flags
  overload explicitly. Falsely compact type, not a runtime failure.

- **NIT — `companies.jump` declares `NOT_ACCEPTABLE` with no per-operation test row.**
  §11 requires "every error code the operation documents in its registry `errors` field". 406 is covered only by the
  central mapping test (`test/core-agent-layer.test.ts:730`), not in `test/resources/companies.test.ts`.

## Release-gate note (not a code finding)

- **`node scripts/check-capabilities.mjs --ship` currently FAILS** — 2 × `[ship-status]`: `operations.searchAcrossResources`
  and `operations.resolveAny` are `status="planned"`. Plain `check-capabilities.mjs` passes (0 failures). If
  `src/operations/**` is the concurrent implementer's path, this resolves itself; otherwise the ship gate is red and
  the run cannot ship as-is.

## VERIFIED OK (checks actually performed, with evidence)

- Gate, clean: `node scripts/check-capabilities.mjs` → `PASS — 0 failures; rows=225 scoped=225 registryRecords=223
  warnings=66` (exit 0). Per group: `--group A|B|C|D` → 77/57/42/47 rows scoped, all `PASS — 0 failures`.
- Negative fixture: `node scripts/check-capabilities.mjs --plan test/fixtures/capabilities.plan.drifted.json` → exit 1. ✅
- Tests: `npx vitest run` → `48 passed (48)`, `1447 passed (1447)`, 2.25 s. So every `status:"tested"` row is backed by
  a test that runs against real code paths (the resource tests stub `fetch` and assert URLs, request counts and
  error `code`/`category`/`resourceIds`, e.g. `test/resources/companies.test.ts:182-380`).
- Helper floor (§5): `resolve` exists on 34 of 35 resources; the only gap is `s3_exports`, which the code and SCOPING
  decision 14 document as a write-only resource with no list/get endpoint and no helper rows — an accepted, recorded
  exception, not an omission.
- `getContext` only on the three approved workflow resources: exactly `companies`, `assets`, `articles`
  (SCOPING decision 10 / J `workflowResources`); no fourth resource has one.
- `search` only where the vendor exposes text search: the 8 `search` helpers (articles, assets, asset_passwords,
  companies, groups, password_folders, users, websites) each map to a vendor `search` query param in `api-docs.json`
  (checked all 35 GET list endpoints programmatically). No resource without vendor search got one.
- Every `findBy<Field>` maps to a real vendor filter: `companies.findByDomain`→`website`, `companies.findBySlug`→`slug`,
  `articles/asset_passwords/websites.findBySlug`→`slug`, `assets.findBySerial`→`primary_serial`, `users.findByEmail`→`email`,
  `networks/ip_addresses.findByAddress`→`address`, `vlans.findByVlanId`→`vlan_id`, `lists.findByName`→`name`,
  `matchers.findBySyncId`→`sync_id`, `magic_dash.findByCompany`→`company_id`, `photos.findByPhotoable`→`photoable_type/id`,
  `flags.findByFlagable`→`flagable_type/id`, `labels.findByLabelable`→`labelable_type/id`,
  `activity_logs/expirations.findByResource`→`resource_type/id`, `relations.findByEndpoints`→`fromable_*/toable_*`.
  No helper was invented for a field the vendor cannot filter.
- Helper cap §5 (>floor): only 3 helpers are beyond the floor in the whole run —
  `procedures.getWithTasks`, `operations.searchAcrossResources`, `operations.resolveAny`; every resource is at 0–1, well
  inside the 2–4 cap. No compact-shape helper is a thin alias of a primitive: all 65 delegate to a scan/compare/
  projection path (`rg -n 'async (resolve|findBy|search|getContext)' src/resources/*.ts`).
- Scans are bounded (§6): every scan goes through `BaseResource.boundedScan` (`src/resources/base.ts:434`) and the
  caps default to `http.resolution.maxScanRecords/maxScanPages` (client config, 500/4). `rg -n 'Promise\.all|while\s*\('
  src/` returns only: `base.ts:564` (`mapConcurrent`, bounded to `concurrency`, default 4), `http.ts:325` (retry loop
  bounded by the call deadline), `pagination.ts:63` and `asset_layouts.ts:290` (both bounded by `MAX_PAGES`). No
  unbounded `Promise.all` anywhere; no helper walks pages itself outside `boundedScan`.
- Non-paginated endpoints: the SDK's `paginated:false` matches the vendor spec for all 11 endpoints without
  `page`/`page_size` (`/api_info /exports /ip_addresses /lists /networks /procedure_tasks /rack_storage_items
  /rack_storages /s3_exports /vlan_zones /vlans`), `page`/`page_size` are stripped in `pageFetcher`
  (`src/resources/base.ts`), and `lists`/`procedure_tasks`/`exports`/`public_photos` scans therefore report
  `scanTruncated: false` for a complete single fetch. The five B/C/D resources add a capped trim that is honest
  (`networks.ts`/`ip_addresses.ts`/`vlans.ts`/`vlan_zones.ts`/`rack_storages.ts` `exactScan`).
- `resolve` honesty (§6), sampled across all four groups, code-enforced (not test-only):
  `companies.resolve/findByDomain/findBySlug` (`{id}` miss → `NOT_FOUND` from `get()` 404; `null` only after a
  complete scan; `ambiguous` carries `resourceIds: [11,12]`), `assets.findBySerial`, `articles.findBySlug`,
  `folders.resolve` (the scan keeps reading after the first match so a second one can prove ambiguity),
  `users.resolve` (email→slug→name stages stop on the first truncated attempt and `requireResolved` throws
  `RESOLUTION_TRUNCATED`), `activity_logs.resolve` (`definite: true` → NOT_FOUND; `allowClientScan:false` →
  `refuseClientScan`), `relations.resolve` (explicit NOT_FOUND on a complete-scan miss), `public_photos.resolve`,
  `networks.findByAddress`, `lists.resolve/findByName`, `procedures.getWithTasks`, `api_info.resolve`.
  Tests use real capped clients (`cappedClient(25, 1)`) and assert request counts, so the truncation path is
  code-enforced: `test/resources/companies.test.ts:266-278`, plus RESOLUTION_TRUNCATED/RESOLUTION_AMBIGUOUS in 66
  assertions across `test/` (only `NOT_ACCEPTABLE` is never asserted outside the central mapping test).
- Unsupported identifier kinds throw a structured validation error naming accepted kinds
  (`identifierError` / `unsupported*Identifier`, both `category: 'validation'`), e.g.
  `networks.ts` "Accepted identifier kinds: …" + `suggestedAction`.
- Compact shapes (§9): all 58 compact-bearing helpers expose `expand: true`; for all 58 the registry
  `outputSchema.fields` set equals the TS summary interface's field set exactly (machine-compared across
  `src/types/*.ts`); `drops` equals (full record fields − compact fields) for 57/58 — the 58th
  (`procedures.getWithTasks`) correctly pairs with `ProcedureWithTasksFull`. No primitive has a `compact` claim
  (0 of 158), and no projection function is used by a primitive. 29 of 30 "compact keeps the resolve-by field"
  checks pass; the exception is `websites` (HIGH finding above).
- `getContext` bundles are bounded: `companies.getContext` (`src/resources/companies.ts:305-331`), `assets.getContext`
  (`src/resources/assets.ts:358-380`) and `procedures.getWithTasks` (`src/resources/procedures.ts:288-308`) each fetch
  `page_size: <helper limit>` and stop with a `take`/`break` at `limit`; none calls `listAll`; `articles.getContext`
  issues no list request at all (article + company + folder only).
- `limit` policy (§9): default 25, hard max 100, throws (never clamps) in all 13 copies of the validator; tests assert
  it (`test/resources/users.test.ts:306-319`, `test/resources/articles.test.ts:145-149` → `CONFIG_ERROR` at 101).
- Typecheck clean: `npx tsc --noEmit` → no output, exit 0.
- Error contract: `HuduConfigError` → `CONFIG_ERROR`/`category:'validation'`; `ValidationFailedError` →
  `VALIDATION_FAILED`; `ResolutionError` → `category:'resolution'`, `retryable:false` with `suggestedAction`
  (`src/errors.ts`).
- `s3_exports` has no helper and no `resolve`, and its code says so explicitly
  (`src/resources/s3_exports.ts:1-9` + SCOPING decision 14) — verified as an intentional documented absence.

## UNVERIFIED

- **Regenerated manifest content** — I cannot run `scripts/project-mcp-tools.mjs` (writes the repo), so I verified the
  manifest is stale, not what a fresh projection would contain.
- **Coverage thresholds (97/94/83/97)** — I did not run the coverage suite (it rewrites `coverage/`).
- **`src/operations/**`** — absent at this revision; the 2 `operations.*` rows are `status:"planned"` and
  `--ship` fails on them (reported above). Out of scope per the brief.
- **Live-vendor behaviour** — all vendor-filter claims are checked against the local `api-docs.json` spec, not a live
  Hudu instance. In particular the `hasMore: items.length === page_size` assumption and the "server ignores
  `page_size`" analysis in `asset_layouts`/`users` are spec-derived.
- **`public_photos.resolve` ambiguity** — a record can plausibly carry several public photos, and `boundedScan`
  returns the first match; no test asserts that case, so "several public photos for one record" is UNVERIFIED.
- **`articles.getContext` `limit`** — I verified statically that the body never reads it; I did not add a runtime
  probe.
