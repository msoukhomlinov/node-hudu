# Live test: agent-facing helper tier (helpers-resolution lens)

Tenant: Hudu 2.45.1 sandbox (hudu-sandbox.example.com). Branch: feat/agent-execution-layer.
Scope: `resolve`, `findBySlug`, `findByDomain`, `search`, `getContext`, `listAll`, `listPages`,
compact vs `expand: true`, `operations.searchAcrossResources`, `operations.resolveAny`,
pagination without vendor `meta`, non-paginated endpoints, resolution caps.

## Findings

| # | Severity | Type | Claim | Status |
|---|----------|------|-------|--------|
| (filled in as probing proceeds) | | | | |

## 1. Baseline harness (scripts/live-smoke.mjs, 40 checks)

## 2. resolve() — by id / name / slug / domain

## 3. Ambiguity construction (RESOLUTION_AMBIGUOUS)

## 4. Compact vs expand: true

## 5. operations.searchAcrossResources / resolveAny

## 6. Pagination (listAll beyond page 1, no vendor meta)

## 7. Non-paginated endpoints (no page/page_size)

## 8. Resolution caps (maxScanPages / maxScanRecords)

## 9. Cleanup verification

## 10. Could not test (UNVERIFIED)
