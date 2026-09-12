# Mutation Safety — Live Vendor Test (node-hudu)

- Date: 2026-09-12
- Tenant: Hudu 2.45.1 sandbox (hudu-sandbox.example.com), throwaway key (redacted)
- Branch: feat/agent-execution-layer, dist built from current source
- Lens: mutation safety — dry-run must not write, impact must be honest, guards must refuse, executed path must match dry-run

## Method
- Ran existing harness `node scripts/live-smoke.mjs --json /tmp/mutation-safety.json` (40 checks) as baseline.
- New probes: Node scripts spying on `globalThis.fetch` to count/inspect every request issued per call.
- Records created for executed-path tests are deleted before finishing; final list verifies cleanup.

## Findings

| # | Severity | Type | Claim | Status |
|---|----------|------|-------|--------|
| (fill in) | | | | |

## 1. Dry-run zero-write proof (per mutating primitive)
| Primitive | dryRun fetch calls | Non-GET requests | Verdict |
|-----------|-------------------|------------------|---------|

## 2. Dry-run impact honesty
(reversible / affected / exact / scope per primitive)

## 3. Executed-path parity
(audit impact vs dry-run impact for same call)

## 4. Guards (expectedUpdatedAt / assertNotStale)

## 5. limit / page_size validation

## 6. Bulk deletes (executed path, reasoned — NOT executed)

## Cleanup verification

## UNVERIFIED / could not test
