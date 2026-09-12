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
  manifest are generated. A committed negative fixture proves the gate actually fails.

### Notes

- Zero runtime dependencies; Node >= 18; dual ESM + CJS; the existing subpaths are unchanged and
  `./capabilities` and `./operations` are new.
- `ARCHITECTURE.md` gained the agent-execution-layer section that points at the capability matrix;
  `docs/API.md` gained a generated appendix of every operation the registry knows about.
