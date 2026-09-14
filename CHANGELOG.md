# Changelog

All notable changes to **node-hudu** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Fixed

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
