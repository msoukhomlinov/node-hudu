# node-hudu live test — transport, structured errors, audit & MCP surface

- **Date:** 2026-09-12
- **Tenant:** Hudu 2.45.1 sandbox (`hudu-sandbox.example.com`), throwaway user-authorised key
- **Branch:** `feat/agent-execution-layer` (head `5c79bf9`)
- **Lens:** transport, structured errors, audit, redact/logger, MCP surface — live
- **Method:** ran the shared 40-check harness (`scripts/live-smoke.mjs`) as baseline, then targeted probes reusing its patterns (fetch spy, `makeClient`, `strays` cleanup).

> NOTE: the `dist/` shipped with the branch was **stale** (built before the `logger.ts`
> `apiKey` redaction fix). I rebuilt with `npm run build` before probing. The stale-dist
> issue is itself a finding (F-0).

## Baseline (shared 40-check harness)

After rebuild: **38 PASS / 2 FAIL / 0 SKIP**. (Before rebuild it was 34/6 — the 4 extra
failures were all caused by the stale dist, see F-0.)

| Check | Status | Note |
|-------|--------|------|
| C38 registry pagination mode | FAIL | per-op `nonPaginated` flag misread as resource-level (see F-?) |
| C39 create() return type | FAIL | resource lens (vendor envelope) — out of my lens, noted for completeness |

## Findings

| ID | Severity | Category | Claim |
|----|----------|----------|-------|
| F-0 | ? | build/hygiene | dist/ was stale vs source (redact leaked apiKey until rebuild) |
| F-1 | ? | SDK bug / contract | audit event lacks `durationMs` and `status` (C31) |
| F-2 | ? | SDK bug / registry | per-op `pagination.nonPaginated` inconsistent with list (C38) |
| F-3 | ? | transport | 401/404/400/429 error mapping (live) |
| F-4 | ? | transport | retry/timeout behaviour (live + stub) |
| F-5 | ? | audit | onAudit once-per-call, no key leak (live) |
| F-6 | ? | redact | redact()/logger credential masking (live) |
| F-7 | ? | MCP | MCP server end-to-end (live) |

_(table filled in as probing proceeds)_

## 1. Error mapping on a real vendor

_(401 bad key, 404 missing id, 404 missing path, 400 rejected filter, 429 — class/code/category/retryable/httpStatus/resourceIds/suggestedAction/correlationId/vendor message)_

## 2. Retry / timeout behaviour

_(maxRetries retries only 429/5xx/network, never 4xx; correlationId reused across retries; timeoutMs -> timeout error not hang. Note which parts are simulated via local stub / black-hole.)_

## 3. onAudit

_(fires exactly once per call on success AND failure; carries operation/correlationId/durationMs/status; never contains the API key — JSON dump as proof)_

## 4. redact() and the logger

_(masks credential fields, keeps safe ones)_

## 5. MCP end-to-end

_(examples/mcp-server.ts: list tools, call >=5 (read/resolve/dry-run/helper/operations), LLM-usability of results, misleading names/schemas, crashes; sample MCP_TOOL_MANIFEST.md against live client)_

## Cleanup verification

_(final list proving no stray records; pre-existing companies/websites/groups unchanged)_

## Could not test (UNVERIFIED)

_(gaps)_
