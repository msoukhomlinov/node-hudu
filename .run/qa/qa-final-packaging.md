# QA — Final Packaging Review (node-hudu agent-execution-layer retrofit)

- Lens: FINAL PACKAGING (READ-ONLY). Only write: this file.
- Pinned branch: `feat/agent-execution-layer`, pinned HEAD (per brief): `49f7886e5142680e209381cf361a4133d8ba173e`
- **HEAD moved during this review** — branch head at write time: `46b7d3af5163150399ff7208cacd96b385c55461`
- Baseline: `main` @ `9332efe` (v0.2.1)
- Candidate: 0.3.0, additive minor
- Reviewer runtime: Node `v24.18.0`; tarball `node-hudu-0.3.0.tgz` (shasum `67aca080b51db27197df2a9ef1d032fece0a6839`), unpacked at `/tmp/pkgcheck/unpack/package`; TypeScript `5.7.3`
- Status: **COMPLETE — 1 CRITICAL, 2 HIGH, 3 MEDIUM, 4 LOW, 3 NIT. Verdict: NOT SHIPPABLE as packed today.**

## Timeline evidence (why "stale" is the theme)

| Artifact | mtime | stamp |
|---|---|---|
| `dist/index.js`, `dist/capabilities.js` | 13 Sep 01:27:51 | `CAPABILITIES_PLAN_HASH = 65c7cab6af926eec...`, `CAPABILITIES_GENERATED_AT = 2026-09-12T15:17:09.312Z` |
| `docs/API.md` | 13 Sep 01:27:06 | appendix says `planHash 65c7cab6af926eec` |
| `MCP_TOOL_MANIFEST.md` | 13 Sep 02:04:34 | regenerated after the last build |
| `capabilities.json` | 13 Sep 02:08:25 | `planHash da4bf1f2de978259...`, `generatedAt 2026-09-12T16:08:25Z` |
| fix commits `1659924`, `144c6d4`, `46b7d3a` | after 02:00 | landed after the last build |

---

## Findings

### CRITICAL - 1. The packed tarball ships a STALE `dist/`, and ships two disagreeing capability registries

- What is wrong - `npm pack` copies the on-disk `dist/` verbatim, and that `dist/` (01:27:51) predates the last two source fix commits and the last capabilities regeneration (02:04-02:08). The tarball therefore contains compiled code that is not the code under review. The same tarball ships two copies of the capability registry that disagree:
  - `dist/capabilities.js` carries `CAPABILITIES_PLAN_HASH = 65c7cab6af926eec7066b9df0fae99311b456ebdb9da836bfbe73c25d8ef3ded` and `GENERATED_AT = 2026-09-12T15:17:09.312Z`.
  - `capabilities.json` carries `planHash da4bf1f2de978259c8bab92ca0b3f852c7def909637436a8b06f5fc04f07a514` and `generatedAt 2026-09-12T16:04:34.450Z`.
  - 5 field-level diffs between them: `groups.search.inputSchema` and `groups.search.examples`, `websites.search.inputSchema` and `websites.search.examples` (the JSON omits the `resolutionDetails` option and its example), plus `procedures.getWithTasks.resolution` (present in dist as `{basis: composite, maxScanRecords: 500, maxScanPages: 4}`, `null` in JSON).
- Where - `package.json:72` (`files: ["dist", ...]`), `package.json:101` (`"prepublishOnly": "npm run clean && npm run build"`), `.gitignore:2` (`dist/`); tarball `dist/capabilities.js` vs tarball `capabilities.json`.
- Why it matters - The release claim is "the capability registry is the executed truth". A TypeScript consumer calling `getCapability()` from `node-hudu/capabilities` and a non-TypeScript consumer reading `capabilities.json` (or an MCP server projecting a tool manifest from it) get DIFFERENT metadata for the same operation (`resolutionDetails` support, `procedures.getWithTasks` resolution basis). Worse, the compiled bytes are pre-fix: the safety fix `144c6d4` ("the executed audit event now matches its own dry-run on every mutating path") and `1659924` exist only in `src/`.
- Fix - Regenerate and rebuild before any pack: `npm run capabilities:build && npm run mcp:project && npm run build`. Add a `prepack` script so `npm pack` cannot emit a stale `dist/`. Fail the pack when `CAPABILITIES_PLAN_HASH` in `dist/capabilities.js` differs from `planHash` in `capabilities.json`. Then re-pack and re-verify.

### HIGH - 2. `dist/` is gitignored and untracked, and `npm pack` does not run `prepublishOnly`, so the RC artifact is not reproducible from the commit

- What is wrong - `dist/` is ignored (`.gitignore:2`) and untracked (`git ls-files dist` returns nothing). `npm pack` runs `prepare`/`prepack`/`postpack`, NOT `prepublishOnly`, and the package defines no `prepack`. So a pack from a clean clone (CI, a fresh worktree, a second maintainer) produces a tarball with an empty `dist/` while `package.json` still declares `main`, `module`, `types` and 7 `exports` subpaths: a package that installs and then fails every import with `ERR_MODULE_NOT_FOUND`.
- Where - `.gitignore:2`; `package.json:6-70` (declared targets); `package.json:72`; `package.json:101` (only `prepublishOnly`).
- Why it matters - The seed evidence "npm pack then install then ESM+CJS import works" is true only on this machine, because `dist/` happens to exist locally. It is not transferable to the commit, so it cannot back a release sign-off. Any tarball-based gate (this one included) can silently validate either stale bytes or nothing at all.
- Fix - Add `"prepack": "npm run build"` (or `prepare`), plus a `verify:pack` script that packs into a temp dir, installs into a clean project and imports every declared subpath in both formats. Run it from a clean clone.

### HIGH - 3. The release candidate was not frozen: HEAD moved and 13 files were dirty DURING packaging QA

- What is wrong - The brief pins `feat/agent-execution-layer` at `49f7886e...`; the branch head is now `46b7d3af...` (later commits, including a safety fix). The working tree was dirty at pack time and mutated while I reviewed it: an early `git status` listed 10 modified files (`src/resources/activity_logs.ts`, `src/resources/magic_dash.ts`, `src/resources/procedures.ts` plus 7 tests); a later one listed 13 different ones (`capabilities.json`, three `scripts/*.mjs`, `src/capabilities.ts`, `activity_logs.ts`, `label_types.ts`, `labels.ts`, `lists.ts`, `magic_dash.ts`, `users.ts`, two tests). The `capabilities.json` I packed (`sha256 171cba4d...`, `generatedAt 16:04:34Z`) is no longer the one on disk (`sha256 2044cc72...`, `generatedAt 16:08:25Z`).
- Where - `git rev-parse HEAD` at pack time vs now; `git status --porcelain` (13 entries at write time).
- Why it matters - `npm publish` runs `prepublishOnly` -> `clean && build`, which compiles the DIRTY working tree, so uncommitted, un-reviewed source would ship. No one can sign off a tarball that corresponds to no commit, and every lens's measurements are snapshots of a moving tree (the registry plan itself moved from `65c7cab6` to `da4bf1f2` mid-run).
- Fix - Freeze before packaging QA: commit or stash everything, confirm `git status --porcelain` is empty, record `git rev-parse HEAD` in the release note, and pack only from that commit. Treat a non-empty tree at pack time as a release blocker.

### MEDIUM - 4. No packaging gate exists in the pipeline

- What is wrong - Nothing automated validates the artifact that ships. There is no `.github/` directory at all (no CI). `npm test` never touches `dist/`: `test/public-surface.test.ts:14` imports `'../src/index.js'`, and `vitest.config.ts` sets `coverage.include` to `src/**/*.ts`. `prepublishOnly` runs only `clean && build` - not `typecheck`, not `test`, not `capabilities:check`, not `mcp:project`. So the additive-only proof, the coverage numbers and the `capabilities:check --ship` gate all describe `src/`, while the published surface (`dist/` + the `exports` map + the root JSON) is ungated.
- Where - `package.json:101`; `test/public-surface.test.ts:14`; `vitest.config.ts`; absence of `.github/`.
- Why it matters - The exact defect class in finding 1 (stale `dist/`, split registry) cannot be caught by any existing gate, so it will recur at the next release.
- Fix - Add a CI/pre-publish job: `npm ci && npm run typecheck && npm test && npm run capabilities:check -- --ship && npm run build && npm pack`, then install the tarball into a clean dir, import every declared subpath in ESM and CJS, and typecheck a consumer file.

### MEDIUM - 5. Shipped `docs/API.md` appendix is stale and omits one real operation

- What is wrong - `docs/API.md:853` states "Generated from `capabilities.json` (planHash `65c7cab6af926eec`)". Neither the shipped `capabilities.json` (`planHash da4bf1f2de978259...`) nor the authored plan (`sha256(capabilities.plan.json) = da4bf1f2de978259c8bab92ca0b3f852c7def909637436a8b06f5fc04f07a514`, which I computed) carries that hash. The appendix table has 224 rows for 225 operations; the missing one is `s3_exports.create` (present in `capabilities.json` and in the runtime registry). No script regenerates the appendix: `grep -rn 'Appendix - capability registry' --include='*.mjs'` returns nothing, and only `generate-capabilities.mjs` and `project-mcp-tools.mjs` write files (neither touches `docs/API.md`). A machine comparison of the 224 documented rows against `capabilities.json` found no mismatches beyond comma spacing, so the drift is the hash stamp plus the one missing row.
- Where - `docs/API.md:853` and its appendix table; `package.json:79` (`docs` is shipped).
- Why it matters - The tarball's own reference doc asserts a plan revision the tarball does not contain, and a shipped operation (`s3_exports.create`) is undocumented. `CHANGELOG.md:17` correctly says `s3_exports` has no HELPERS; the appendix should still list its primitive.
- Fix - Generate the appendix from `capabilities.json` (reuse `project-mcp-tools.mjs`) in `prepublishOnly`/CI, or correct the hash and add the missing row by hand; add a check that compares appendix row count to `operationCount`.

### MEDIUM - 6. Sourcemaps inline the whole `src/` tree and account for 75 percent of unpacked size

- What is wrong - `tsup.config.ts` sets `sourcemap: true`; the 20 shipped `.map` files total 3.4 MB of the 9.3 MB unpacked package (`dist/` is 7.8 MB). They carry `sourcesContent`: `dist/capabilities.js.map` alone inlines 494,633 characters of `../src/capabilities.ts`. Meanwhile `files` deliberately excludes `src`.
- Where - `tsup.config.ts` (`sourcemap: true`); `package.json:72`.
- Why it matters - The `files` whitelist's intent (do not ship sources) is defeated: full source is readable inside the tarball. The package is roughly 4x larger than the code needs, and `sources: ["../src/capabilities.ts"]` names a path that does not exist in the package, so a debugger that trusts the path over `sourcesContent` reports a missing source.
- Fix - Either drop `sourcemap` for the published build, or strip `sourcesContent`, and exclude `*.map` from `files` if maps are not wanted.

### LOW - 7. README's `resolve` example types the expanded result as `Company`, but that path is nullable

- What is wrong - `README.md:127` reads `const full = await hudu.companies.resolve({ name: 'Acme' }, { expand: true }); // Company`. The real signature returns `Promise<Company | null>` for every non-`{id}` identifier (only an `{ id }` hit is total). A strict consumer copying the snippet gets `error TS2322: Type 'Company | null' is not assignable to type 'Company'` - I hit exactly that while writing the consumer typecheck.
- Where - `README.md:127` vs `dist/client-DNdEaPtK.d.ts` (`resolve(identifier, opts: HelperOptions & { expand: true }): Promise<Company | null>`).
- Why it matters - The docs are the "does it actually run" contract; this costs every reader a compile error on the first snippet they copy.
- Fix - Change the comment to `// Company | null (a name lookup can miss)`, or annotate the `{ id }` form instead.

### LOW - 8. Build output is not reproducible, and the wall-clock stamp hides drift

- What is wrong - `dist/capabilities.js` bakes `CAPABILITIES_GENERATED_AT = "2026-09-12T15:17:09.312Z"` and `CAPABILITIES_PLAN_HASH` at codegen time. Two builds of identical input therefore produce different bytes, so two tarballs of the same commit never match. Because the stamp lives inside dist, nobody notices when `dist` and `capabilities.json` come from different generations - which is exactly finding 1.
- Where - `dist/capabilities.js` (`CAPABILITIES_GENERATED_AT`); tarball `capabilities.json` (`generatedAt`).
- Why it matters - Reproducible-build tooling and tarball diffing are impossible, and the drift is invisible at release time.
- Fix - Emit `GENERATED_AT` from `SOURCE_DATE_EPOCH` when set, or drop the timestamp from the compiled module; add a check that `dist/capabilities.js`'s `CAPABILITIES_PLAN_HASH` equals `capabilities.json.planHash`.

### LOW - 9. `sideEffects` is not declared, so the 545 KB registry module cannot be tree-shaken

- What is wrong - `package.json` has no `sideEffects` field. `dist/capabilities.js` is 545,015 bytes of static data whose only top-level work is object construction, and the root `dist/index.js` re-exports it, so a bundler must conservatively keep all of it.
- Where - `package.json` (field absent).
- Why it matters - For the stated target (MCP servers that bundle the SDK), a missing `sideEffects: false` measurably bloats the consumer bundle.
- Fix - Add `"sideEffects": false` (dist has no import-time side effects), or narrow it if any entry does.

### LOW - 10. The published `package.json` advertises scripts whose files are not shipped

- What is wrong - The tarball ships `package.json` verbatim (byte-identical after JSON normalisation) but not `scripts/`, `test/`, `tsconfig.json` or `vitest.config.ts`. In an installed copy, `capabilities:build`, `capabilities:check`, `plan:derive`, `mcp:project`, `lint`, `lint:fix`, `typecheck`, `test`, `test:coverage` and `clean` all fail (`scripts/derive-plan.mjs` not found; `eslint src test` has no such directories).
- Where - `package.json:87-101` vs `tar -tzf` contents.
- Why it matters - Misleading for anyone auditing an installed copy or trying to reproduce the generated artifacts from the package alone.
- Fix - Accept it (common practice) or strip the developer scripts before publishing; do not document them as consumer-runnable.

### NIT - 11. Three small packaging/API cosmetics

- `limit` validation quotes a numeric argument: observed `CONFIG_ERROR: limit must be an integer from 1 to 100, got "101"` from the installed tarball. Drop the quotes for numbers.
- `dist/chunk-AVIVJAJZ.js:26` uses `import { randomUUID } from "crypto"` (CJS twin `require('crypto')`) instead of the prefixed `node:crypto`. It resolves under Node, but the prefixed builtin is the safer, conventional form.
- No `publishConfig` block (no `provenance: true`, no explicit `access`/`registry`). For a release candidate whose selling point is deterministic execution, provenance attestation is cheap.

---

## VERIFIED OK

Each row names the command behind the claim.

1. Every `exports` target exists for BOTH `import` and `require` conditions, with types: 0 missing of 26 targets. Command: parsed the tarball `package.json` `exports` and ran `os.path.exists` on each target against the unpacked tree -> `MISSING EXPORT TARGETS: []`.
2. No emitted entry is unreachable, and `exports` declares nothing that is not an emitted entry. Command: `cat tsup.config.ts`; `find dist -type f | sort`; set-difference of the tsup entry set (root + `resources` + `types` + `errors` + `capabilities` + `operations`) against the exposed set -> both directions empty.
3. Subpaths `.`, `./resources`, `./types`, `./errors`, `./capabilities`, `./operations`, `./package.json` all resolve in ESM and CJS from an installed tarball. Command: clean `/tmp/consumer-esm` -> `npm install /tmp/pkgcheck/node-hudu-0.3.0.tgz` -> `node run.mjs` (dynamic `import()` of each subpath), exit 0.
4. 0.2.1 users do not break: `main`@`9332efe` declares exactly `.`, `./resources`, `./types`, `./errors`, `./package.json`, and 0.3.0 is a strict superset (adds `./capabilities`, `./operations`). No `./dist/*` wildcard existed before, so no deep path regressed. Command: `git show 9332efe:package.json` vs the tarball `package.json`.
5. `npm pack` ships 70 files with no `src/`, `test/`, `scripts/`, `tsconfig*.json`, `.run/`, plan or lockfile. Command: `tar -tzf node-hudu-0.3.0.tgz | sort` (full list reviewed).
6. Everything the metadata and docs reference is present: `dist` (all subpaths), `examples/basic.ts`, `examples/mcp-server.ts`, `examples/search-assets.ts`, `docs/API.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `capabilities.json`, `capabilities.schema.json`, `MCP_TOOL_MANIFEST.md`, `LICENSE`, `README.md`. Command: `tar -tzf` list vs `package.json.files` (`package.json:72-82`).
7. Zero runtime dependencies: no `dependencies` key at all; `zod` and `@modelcontextprotocol/server` are in `devDependencies` only; installing the tarball pulls 1 package (no transitive deps). Commands: full `package.json` read; `cd /tmp/consumer-esm && npm install <tgz>` -> `added 1 package in 511ms`.
8. No bare runtime specifier in `dist` except the Node builtin `crypto`; no `zod` and no `@modelcontextprotocol/*` (the only hits are JSON-schema text inside the registry data). Commands: `grep -nEo "(require\(|from ?)['\"][^'\"]+['\"]" *.js *.cjs` filtered against `./`, `../`, `node:`; `grep -rnE 'zod|modelcontextprotocol' dist --include='*.js' --include='*.cjs'` -> empty.
9. Runtime surfaces work from the installed tarball with a stubbed global `fetch` and a bogus base URL (`https://bogus.invalid`): primitive read -> 1 request `GET https://bogus.invalid/api/v1/companies?page=1&page_size=25`, returns the record; helper `resolve('acme.com')` -> 3 server-filtered probes (`slug=`, `name=`, `website=`); dry-run `delete(42, { dryRun: true })` -> 0 requests issued, plan `{simulated: true, impact: {affected: 1, scope: 'single', reversible: false}, request: {method: 'DELETE', path: '/companies/42'}, checks: [{name: 'target-identifier', ok: true}]}`; `getCapability('companies.resolve')` -> `{kind: 'helper', effect: 'read', dryRun: false, flags: [], ...}`; `operations.searchAcrossResources('acme', {resources: ['companies']})` -> 1 request, returns a typed hit. Commands: `/tmp/consumer-esm/run.mjs` and `/tmp/consumer-esm/run2.mjs`, both exit 0.
10. `HuduConfig` validation is real: a base URL carrying a path throws `HuduConfigError: baseUrl must be an origin (no path). Got path "/api/v1"`. Command: first run of `/tmp/consumer-esm/run.mjs`.
11. Doc claims spot-checked against the shipped runtime, all agreeing: `DEFAULT_PAGE_SIZE = 25`; `limit` throws above 100 with `limit must be an integer from 1 to 100` (throws, does not clamp); scan bounds `DEFAULT_MAX_SCAN_RECORDS = 500` and `DEFAULT_MAX_SCAN_PAGES = 4`; `DEFAULT_CONCURRENCY = 4`; `DEFAULT_BASE_PATH = /api/v1`; registry `CAPABILITY_NAMES.length = 225`; `{ resolutionDetails: true }` returns `{resolutionCost, scanned, scanTruncated}`; 34 resources expose `.resolve` with `s3_exports` write-only, matching the CHANGELOG's "35 resources, s3_exports has no helpers" claim. Command: `/tmp/consumer-esm/run2.mjs`.
12. README's advertised API names all exist on the real client: `companies.resolve`, `companies.getContext`, `companies.delete`, `assets.findBySerial`, `websites.search`, `operations.resolveAny`, `operations.searchAcrossResources`, `redact()`. The `getCapability` key set is `[compact, dryRun, effect, errors, examples, flags, inputSchema, kind, name, outputSchema, pagination, permissions, preferredWhen, purpose, related, resolution, resource, retry, usage]`, exactly the fields README advertises. `onAudit` is a `HuduConfig` option (`websites-CzW9rRtS.d.ts:217`), not a client method, which matches README's phrasing. Command: `/tmp/consumer-esm/run2.mjs` `typeof` probes.
13. TypeScript consumers typecheck cleanly, root plus `capabilities` plus `operations` plus `errors` plus `types`: `companies.search('acme', {limit: 5})`, `companies.resolve(42, {expand: true})`, `companies.resolve({name: 'Acme'}, {expand: true})`, a dry-run assigned to `DryRunResult<void>` with `.impact.affected` and `.impact.reversible` read, `SearchAcrossResourcesOptions`, plus a `.cts` file exercising the `require` condition (`.d.cts`). Exit 0 in both modes with `skipLibCheck: false`. Commands: `typescript@5.7.3`; `"module": "node16", "moduleResolution": "node16"` -> `EXIT_NODE16=0`; `"module": "esnext", "moduleResolution": "bundler"` -> `EXIT_BUNDLER=0`; run as `./node_modules/.bin/tsc -p tsconfig.json`.
14. Legacy fields are consistent and exist: `main` -> `./dist/index.cjs`, `module` -> `./dist/index.js`, `types` -> `./dist/index.d.ts`, all matching the `exports` `.` conditions. Command: `package.json:6-8` vs the unpacked tree.
15. The capability gate passes on the candidate: `PASS - 0 failures; rows=225 scoped=225 registryRecords=225 warnings=66` (exit 0); the 66 warnings are informational `unplanned-surface` notes for `listAll`/`listPages`. Command: `npm run capabilities:check -- --ship`.
16. `engines: node >=18` is honest for the emitted code: `tsup` uses `target: 'node18'`, and a grep of `dist` for post-18 APIs (`Object.groupBy`, `Promise.withResolvers`, `.toSorted(`, `.toReversed(`, `.findLast(`, `Array.fromAsync`, `using`) found none; the SDK relies on global `fetch`/`AbortController` (Node 18+). Commands: `cat tsup.config.ts`; grep over `dist/*.js dist/*.cjs`; runtime Node `v24.18.0`.
17. `capabilities.json` is current with the authored plan: `sha256(capabilities.plan.json) == capabilities.json.planHash == da4bf1f2de978259c8bab92ca0b3f852c7def909637436a8b06f5fc04f07a514`. Command: Python `hashlib.sha256` over the plan file.
18. `capabilities.json` and `MCP_TOOL_MANIFEST.md` both ship at the package root, and the manifest is a projection of the registry (`project-mcp-tools.mjs` reads `capabilities.json` and writes `MCP_TOOL_MANIFEST.md`). Command: `grep -n 'capabilities.json|MCP_TOOL_MANIFEST' scripts/project-mcp-tools.mjs`; `tar -tzf`.
19. The tarball's `package.json` is byte-equivalent to the repo's (JSON-normalised diff is empty), so nothing is rewritten or stripped at pack time. Command: `diff <(json.dumps(tarball)) <(json.dumps(repo))` -> identical.

## UNVERIFIED

1. Byte-level tarball reproducibility. Measuring it needs `npm run build` / `capabilities:build` inside the repo, which writes `dist/` and `src/capabilities.ts` - out of scope for a read-only lens. The `CAPABILITIES_GENERATED_AT` wall-clock stamp (finding 8) implies non-reproducibility, but I did not measure it.
2. `npm publish` behaviour. I did not run `publish`. The prediction that `prepublishOnly` rebuilds `dist/` from the dirty working tree is read from `package.json:101` plus npm's lifecycle rules, not observed.
3. `capabilities.schema.json` validating `capabilities.json`. No JSON-Schema validator was available in the sandbox (no `ajv` among the pre-installed packages; no network install attempted). The schema ships and is referenced, but I did not validate against it.
4. The published 0.2.1 artifact on the npm registry. My 0.2.1 subpath parity check used the repo at `main@9332efe`, not the tarball actually on npm. If published 0.2.1 differs from that commit, parity is not proven.
5. `MCP_TOOL_MANIFEST.md` row-level equality with the registry. I confirmed presence, provenance, size (944,926 bytes) and that it is regenerated after the registry, but I did not diff every tool row. It was written at 02:04 while `dist/capabilities.js` is 01:27, so it may carry the same drift as finding 1.
6. Mid-review mutation. Findings 1, 3 and 5 are measured against the state at pack time (HEAD `49f7886e...` plus dirty tree). HEAD is now `46b7d3af...` with 13 dirty files, and the current tree's registry already differs from the packed one (2 record diffs: `procedures.list.pagination.maxPageSize` 1000 -> 100, `procedures.getWithTasks.resolution` added). Re-pack and re-run before sign-off.
7. Prose accuracy of `ARCHITECTURE.md` and `CHANGELOG.md` beyond the specific claims I spot-checked (rows 11 and 12 above, finding 5).

## Verdict

NOT SHIPPABLE as `npm pack` stands today. The package STRUCTURE is sound: the export map, both module formats, the shipped type declarations, the zero-dependency claim, the tar contents and every runtime surface I exercised all pass, including from the installed tarball. What fails is the ARTIFACT: the tarball carries a stale `dist/` that predates the last two fix commits, two capability registries that disagree with each other, and a `docs/API.md` appendix stamped with a plan revision no shipped file contains. All three trace to one gap: no `prepack`/CI step regenerates, rebuilds and cross-checks the generated artifacts before anything is packed, and the tree was not frozen. Ship after: freeze the tree, run `capabilities:build && mcp:project && build`, re-run `typecheck`, `test` and `capabilities:check --ship`, re-pack from the frozen commit, then re-run rows 1-9 and 13 above against the new tarball.
