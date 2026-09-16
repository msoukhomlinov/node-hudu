# Changelog

All notable changes to **node-hudu** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-09-17

### Added

- **`node-hudu/mcp`** — the generated MCP tool catalog is now a first-class, compiled subpath
  export. `CORE_TOOLS`, `META_TOOLS`, `TOOL_DESCRIPTIONS`, `SEARCH_MODES`, `SEARCH_RESOURCES`,
  `SEARCH_HELP`, `CATALOG`, `EXPOSED`, `REFUSALS`, `CATALOG_PLAN_HASH`, `CORE_RULE`,
  `WORKFLOW_RESOURCES` and the runtime helpers (`catalogPage`, `catalogRow`, `nearestKeys`,
  `requireCatalogRow`, `describeOperation`, `inputFields`, `configError`) import from both ESM and
  CJS, with types for each. The catalog is still generated, still carries no second validator and no
  second write governor, and still imports nothing at runtime.

- **Hudu article HTML rules** (`src/resources/article-html.ts`, exported from the package
  root and from `node-hudu/resources`) — three pure functions, no HTTP, no new dependency:
  - `validateArticleHtml(html, opts?)` returns structured findings with stable `code`s, a
    `severity`, a `content`-vs-`presentation` `impact`, the `element` family and a location
    hint. Never throws, never mutates.
  - `normalizeArticleHtml(html)` returns corrected HTML for the two mechanically-safe fixes
    only (mirror a `language-X` class from `<pre>` onto `<code>`; unwrap a hand-added
    `rich_text_content__table-scroll` div). **Opt-in and idempotent — no write path calls it.**
  - `diffArticleRoundTrip(sent, readBack)` returns an enumerable list of what Hudu changed
    across tables, code blocks, links and images. The `/public_photo/<slug>` `src` rewrite is
    expected behaviour and is never reported.
  - `ARTICLE_HTML_PROVENANCE` declares the audit the rules came from (2026-09-16, Hudu's
    container CSS and the compiled Tiptap/ProseMirror editor schema), and `ARTICLE_HTML_RULES`
    carries a per-rule verification date, so a consumer can tell stale rules from current ones.

### Changed

- The catalog is generated into **`src/mcp/catalog.generated.ts`** instead of
  `examples/tool-catalog.generated.ts`. It was previously published under `files[]` as uncompiled
  TypeScript, which a compiled consumer could not import; it is now compiled by tsup like every
  other entry point. `scripts/build-tool-catalog.mjs --out` and `scripts/check-capabilities.mjs
  --catalog` default to the new path. No tool name, title or description changed.
- `examples/mcp-server.ts` imports the catalog from `node-hudu/mcp` rather than a relative path to
  the generated file, which is what a real host does.

### Documentation

- `ArticlesResource.get`, `findBySlug` and `ArticlesListParams.slug` now document the two
  long-standing gotchas (both established 2026-07-25): the REST API has no `include_content`
  flag — an "empty" body is the compact `ArticleSummary` dropping `content` — and the `slug`
  filter matches the stored slug exactly, not the trailing SEO suffix of an article URL.

## [0.4.0] — 2026-09-15

**Additive: pluggable auth strategies (issue #23).** No **existing** method signature changed and no
return shape changed; the one signature that grew is `HuduClient`'s constructor, which gained an
optional second parameter (the shared transport state that `withAuth()` passes so scopes share one
rate budget). `API_KEY_HEADER`, `buildAuthHeaders` and `withAuth` are unchanged and still exported.

### Added

- **`AuthStrategy`** (`{ name, headers(ctx), secretHeaders? }`) with three built-ins: `ApiKeyAuth`
  (the historical `x-api-key` header), `BearerTokenAuth` (`Authorization: Bearer <token>`, for a
  Hudu-fronting bearer proxy) and `HeaderAuth` (any header set). The types `AuthContext` and
  `AuthHeaders` are exported from the package root.
- **`HuduConfig.auth`** as an alternative to `apiKey`. Exactly one of the two must be supplied;
  supplying both, neither, or a non-strategy `auth` throws `CONFIG_ERROR` before any request, so a
  request is never sent without a credential. `ResolvedConfig.auth` is always present, and
  `ResolvedConfig.apiKey` is `''` when a strategy is used.
- **`client.withAuth(strategyOrToken)`** — a scoped `HuduClient` that shares the parent's rate-limit
  bucket, queue, logger and audit hook and differs only in its credential. A remote multi-user MCP
  server can now resolve the end user's credential per request instead of holding one process-wide
  key. A bare string is an API key; pass `new BearerTokenAuth(token)` for a bearer token.
- **`RequestOptions.auth`** — a per-request credential override for callers that drive `HttpClient`
  (and `download()`) directly.
- **`AuthError`** (`AUTH_ERROR`, category `auth`, not retryable): the credential could not be resolved,
  so no request was sent. Distinct from `UnauthorizedError` (the server rejected a credential that was
  sent).
- **An async-capable `headers(ctx)` hook**, resolved at most once per attempt, so a retry after
  backoff can pick up a rotated credential.
- **`examples/mcp-server-http.ts`** — a remote, multi-user MCP server reference: verify the caller's
  bearer token, then scope the shared client to that caller's own per-request credential.

### Changed

- The transport builds its headers **inside** the retry loop instead of reusing one object built
  before it. Precedence is unchanged (strategy headers < caller `headers` < `Accept` <
  `Content-Type`), but duplicate header names that differ only in case now **collapse to one value**:
  a caller that passed e.g. `{ accept: 'text/plain', Accept: 'application/json' }` used to get both
  values combined into a single header (`accept: "text/plain, application/json"`) and now gets the one
  winning value (`accept: "application/json"`). Name each header once, in its canonical casing.
- Redaction is extended: the key names `bearer`, `jwt` and `auth_header` are masked, and the suffix
  rules now also cover any `…authorization` / `…apikey` spelling. `redact()` and `isCredentialKey()`
  take an optional extra-name list so a strategy's declared secret headers are masked too.
- `HuduConfig.apiKey` is now optional **in the type only** (it must be present unless `auth` is set);
  `ResolvedConfig.apiKey` stays a required `string`. No **existing** method signature changed; the
  only addition is the optional second `HuduClient` constructor parameter noted above.

### Notes

- Backwards compatible: `apiKey` still works and still produces the same `x-api-key` request. The
  release is a minor bump because everything it adds is additive.
- Hudu's API document defines only `APIKeyHeader`. `BearerTokenAuth` targets a bearer-accepting proxy
  in front of Hudu; the SDK never performs an OAuth flow.

## [0.3.0] — 2026-09-13

**The SDK is now a deterministic execution layer for agents, and still a conventional typed client.**
Everything here is additive: no existing method changed its signature or return shape, and no existing
error code changed meaning. `test/public-surface.test.ts` proves that against the 0.2.1 baseline.

### Added — helper tier (every resource)

- **`resolve(identifier)`** on all 35 resources (34 record-bearing resources and `api_info`, whose
  singleton is a documented degenerate case; `s3_exports` is write-only so it has no helpers at all).
  An `{ id }` miss throws `NOT_FOUND`; `null` means a *complete* scan found nothing; a scan stopped by
  its cap throws `RESOLUTION_TRUNCATED`; several exact matches throw `RESOLUTION_AMBIGUOUS` with the
  candidate ids. Pass `{ resolutionDetails: true }` for a `Resolution<T>` with `resolutionCost`,
  `scanned` and `scanTruncated`.
- **`findBy<Field>()`** where Hudu actually filters on the field and callers look up by it
  (`findByDomain`, `findBySlug`, `findBySerial`, `findByAddress`, `findByVlanId`, `findByEmail`, …).
- **`search(query, { limit })`** where Hudu exposes text search. `limit` defaults to 25 and throws above 100.
- **`getContext(id)`** on the three workflow resources (`companies`, `assets`, `articles`) — the record
  plus its related records, each sub-list bounded.
- **Cross-resource helpers** in `node-hudu/operations`: `searchAcrossResources(query, { resources, limit })`
  and `resolveAny(identifier)`. Both fan out at a bounded concurrency (default 4) and never call `listAll`.
  Also reachable as `hudu.operations.*`.
- **Compact shapes** (`CompanySummary`, `AssetSummary`, …) returned by helpers by default, with an
  `expand: true` escape hatch. Primitives still return the full record, and each summary declares exactly
  which fields it drops in the capability registry.

### Added — capability registry

- **`capabilities.plan.json`** (authored) → **`src/capabilities.ts`** (generated) →
  **`capabilities.json`** + **`capabilities.schema.json`** (emitted at the package root).
  One record per operation: purpose, input/output schema, examples, `effect`, flags, `dryRun`,
  `permissions`, `pagination`, `resolution`, `retry`, `errors`, `related`, `preferredWhen`, `usage`.
  Import it from `node-hudu/capabilities`.
- **`MCP_TOOL_MANIFEST.md`** projected from the registry, curated through `MCP_TOOL_OVERRIDES.json`:
  search-first tool names, bounded results, helper-tier backing for reads, a single dry-run affordance on
  every mutation, and no binary or download tools.

### Added — mutation safety

- **`{ dryRun: true }` on every mutation** (create, update, delete, archive, unarchive, the special
  writers, and the three bulk operations). A dry run performs its checks and **cannot issue the write**;
  it returns a `DryRunResult<T>` with `simulated: true`, a request description, the checks it ran, a
  best-effort `diff`, and an impact statement `{ affected, scope, reversible, exact? }`.
  `exact: false` marks a floor rather than a final count, and `reversible` is only ever `true` where the
  API really offers an undo path.
- **Classification on every operation**: `effect` (`read`/`write`/`destructive`) plus
  `sensitive`, `idempotent` and `requiresApproval` where they apply. Bulk deletes refuse to run
  unconfirmed (`POLICY_DENIED`) and declare their impact bound.
- **Stale-object guard**: pass `{ expectedUpdatedAt }` to a resource `update()` and a changed record
  raises `STALE_OBJECT` before anything is written. Creates and deletes refuse the option rather than
  ignoring it.
- **Audit hook**: an optional `onAudit(event)` receives one event per request with the correlation id,
  the operation, the effect, the outcome and the impact. One `redact()` helper removes credential-shaped
  fields from what you log; returned data is never silently redacted.

### Added — structured errors

- Every error carries `code`, `category`, `operation`, `retryable`, `httpStatus`, `vendorError`,
  `resourceIds`, `suggestedAction` and `correlationId`, so a caller can decide without parsing strings.
  `status` remains as a deprecated alias of `httpStatus`. New classes: `ConflictError`,
  `StaleObjectError`, `ResolutionError`, `PolicyDeniedError`, `ValidationFailedError`, `DuplicateFoundError`.

### Added — tooling

- `npm run plan:derive` (spec + source tree → the capability plan), `npm run capabilities:build`
  (plan → registry + emitted JSON), `npm run capabilities:check` (the drift/coverage/metadata gate,
  with `--group`, `--ship` and `--plan`), `npm run mcp:project` (registry → MCP manifest), and
  `npm run public-surface` (capture the exported surface).
- `capabilities.plan.json` is the single authored source; the registry, the JSON, the schema and the MCP
  manifest are generated. A committed negative fixture proves the gate actually fails, and it is wired
  into `npm test` (`test/negative-fixture.test.ts`, which runs `scripts/check-negative-fixture.mjs`
  and asserts the gate exits non-zero on the fixture with minimum rule-based failure counts).

### Added — search transparency and include-group pins (post-PR-22 follow-ups)

- `meta.index.lastFullAt` / `lastCompleteFullAt` / `fullWalkDue` (and the same three fields on
  `status()`) let a caller tell an incremental warm from a full re-walk: `staleness` alone cannot,
  because any build resets the age. `lastFullAt` is the scheduler's clock (a full walk ran, truncated or
  not); `lastCompleteFullAt` is the honest completeness claim (only an untruncated walk has seen the
  whole collection), and `fullWalkDue` is measured from THAT — so a corpus whose walk is always capped
  reports "may still be missing records" instead of claiming otherwise, while the scheduler still does
  not re-walk on every build.
- The relation include-groups are now pinned on both halves of the contract: `src/type-assertions.ts`
  (compile-time assertions, checked by `tsc --noEmit`, so a loosened inference fails the gate) and the
  `include-groups` rule in `check-capabilities` (an include-bearing operation must publish the four group
  names and its include-expanded output variant).

### Fixed

- An `include` array the compiler cannot narrow no longer infers the plain shape. Each list-shaped call
  and `assets.search` now carry ONE generic overload whose return depends on what the compiler can prove:
  a literal, `as const` tuple or typed `AssetIncludeGroup[]` still resolves to the expanded records; a
  `string[]`, a readonly array, or an OPTIONAL widened property (`{ include?: string[] }`, possibly absent
  at runtime) resolves to the union; no `include` (or an explicit `undefined`) resolves to the plain
  records — with `search`'s `expand` still selecting summaries versus full records, and an EMPTY literal
  array taking the plain shape because it requests no groups. A value the compiler knows as a tuple of
  names is still VALIDATED against the four groups (a typo like `['expiration']` is a compile error naming
  the offending name), because accepting a `string[]` must not cost the typed contract; a widened array is
  accepted and widens the return instead. Before, a widened array matched a plain overload through
  `ListParams`' index signature, so the type said `Asset` while the runtime fetched the includes the array
  held, and `assets.search` refused the call outright. The union is a statement about what MAY be present,
  not an enforcement: `AssetWithIncludes` adds only optional group fields to `Asset`, so a caller can
  still annotate the result as the plain shape.
- The cross-resource helpers' `resources` parameter (`operations.resolveAny`,
  `operations.searchAcrossResources`) now projects as a string enum of the eight searchable
  resources instead of an unresolvable object item that the invoke validator refused in both
  directions. The gate gained the `inputSchema-unresolved-item` rule, which fails on any named
  unresolvable input-schema emission; `label_types`' wrapped-literal-union items
  (`applicable_record_types`) project as string enums for the same reason.
- The MCP manifest, the override reasons and the script comments no longer cite the deleted
  run-state directory (the former `.run` working tree); the manifest was regenerated from the
  cleaned overrides.
- A search that scores index rows and then awaits the vendor tier answers from that exact document
  generation: a rebuild completing during the await can no longer re-point a scored row at another
  document, nor crash hydration with a raw `TypeError`. Indexed documents are immutable to a live
  reader, so a re-upsert of the same record cannot change what a scored row reports; the document
  array is copied away from a reader on the first write while that reader is live. The answer's index
  block describes the generation its hits came from (statistics, body signals, age), with
  `indexChangedSinceScore` telling the caller when the index content has moved on since — so a response
  can no longer serve a body snippet beside "no bodies are indexed" — and the LRU clock that orders text
  eviction is updated by document KEY, so a rebuild cannot make it protect an unrelated record.
- A capped full re-walk keeps the documents it never reached: delete-by-absence applies only to a
  resource whose walk actually completed.
- `resolve(..., { limit: 1 })` no longer returns the first duplicate as a unique match. The
  uniqueness decision collects at least two candidates in all six affected resources (and in
  `matchers.resolve`'s sync-id path); `limit` bounds the returned list, not the decision.
- The knowledge index releases an evicted document's text as ONE unit (`longText` plus the field
  string that holds the same string), so `bodiesIndexed` counts text the index really holds and the
  bound frees what it claims to free (peak live text is the account plus one pinned generation per
  in-flight search, so a single concurrent read can hold up to twice the bound until it ends; those
  generations are not charged to the budget because the reader still needs them). The body recall that
  goes with the text is REPORTED with its own signal — the per-resource `bodiesEvicted` count, the
  `body-evicted` reason, and an advice that names `maxIndexTextBytes` instead of suggesting a retry
  — rather than hidden or blamed on the byte cap (`bodiesTruncated` keeps that meaning, so raising
  `maxDocBytes` is never the answer to an eviction). Keeping the tokens instead would cost several
  times the text they came from (a fix-round probe measured ~5-10x: ~55 bytes/token for prose and
  ~33 for CJK, 200 samples), which would leave the memory bound nominal. The eviction bookkeeping
  also no longer pins documents that `retain`/`capDocs` removed, and `KnowledgeSnippetReason` no
  longer advertises an `evicted` value that no path could produce once the postings go with the text.
- The automatic warm path consults `needsFullRefresh()`, so a deletion is noticed within
  `indexTtlMs * fullRefreshEvery` without an explicit `refresh: true`, and `partial` is cleared by a
  completed full walk instead of latching.
- `refresh: true` is never served by an in-flight incremental build: the requested full re-walk runs
  after it (an incremental cannot see a deletion).
- The response budget is measured in UTF-8 BYTES of the complete serialised response, and an
  overshoot is flagged (`truncation.reason: 'result-limit'`) even when one hit alone exceeds it.
- A failed background index build is named in `meta.errors` and `status().lastBuildError` instead of
  being swallowed by the automatic path.
- Error surfaces no longer echo a request's query string (`HuduError.url` and its message carry the
  path only); the audit redactor covers `passphrase`, `credential(s)`, `auth`, `basic_auth` and
  `session`; the invoke validator refuses non-finite numbers instead of serialising them as `null`;
  and `HuduConfig.apiKey` documents the trim it applies.

### Notes

- Zero runtime dependencies; Node >= 18; dual ESM + CJS; the existing subpaths are unchanged and
  `./capabilities` and `./operations` are new.
- `ARCHITECTURE.md` gained the agent-execution-layer section that points at the capability matrix;
  `docs/API.md` gained a generated appendix of every operation the registry knows about.
