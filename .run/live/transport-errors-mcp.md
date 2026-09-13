# node-hudu live test — transport, structured errors, audit & MCP surface

- **Date:** 2026-09-12
- **Tenant:** Hudu 2.45.1 sandbox (`hudu-sandbox.example.com`), throwaway user-authorised key
- **Branch:** `feat/agent-execution-layer` (head `5c79bf9`)
- **Lens:** transport, structured errors, audit, redact/logger, MCP surface — live
- **Method:** ran the shared 40-check harness (`scripts/live-smoke.mjs`) as baseline, then targeted probes reusing its patterns (fetch spy, `makeClient`, `strays` cleanup, local HTTP stubs for 429/timeout).

> **Build note (F-0):** the `dist/` shipped with the branch was **stale** (built before the
> `logger.ts` `apiKey` redaction fix). I rebuilt with `npm run build` before probing. The
> stale-dist issue is itself a **CRITICAL** finding (F-0): the stale artifact leaked the API key in
> audit events. All results below are against the **rebuilt** dist.

## Baseline (shared 40-check harness)

After rebuild: **38 PASS / 2 FAIL / 0 SKIP**. (Before rebuild it was 34/6 — the 4 extra failures
were all caused by the stale dist, see F-0.)

| Check | Status | Note |
|-------|--------|------|
| C38 registry pagination mode | FAIL | per-op `nonPaginated` flag misread as resource-level (F-2) |
| C39 create() return type | FAIL | resource lens (vendor envelope) — out of my lens, noted for completeness |

## Findings summary

| ID | Severity | Category | Claim |
|----|----------|----------|-------|
| F-0 | **CRITICAL** | build/hygiene (leaked credential) | `dist/` was stale vs source; stale `redact()` leaked `apiKey` into audit events until rebuild |
| F-1 | LOW | SDK gap / contract | audit event lacks `durationMs` and a `status` field (C31) |
| F-2 | LOW | registry metadata / test gap | per-op `pagination.nonPaginated` inconsistent with list; C38 misreads it (C38) |
| F-3 | PASS | transport | 401/404/400/429 error mapping is correct and complete (live) |
| F-4 | PASS | transport | retry/timeout behaviour correct (live + stub) |
| F-5 | PASS (gap F-1) | audit | onAudit fires once per call, no key leak; missing durationMs/status |
| F-6 | PASS (after rebuild) | redact | redact()/logger masks all credential spellings, keeps safe fields |
| F-7 | PASS | MCP | MCP server end-to-end works; results LLM-usable; no crash |
| F-8 | MEDIUM | SDK bug (type/manifest) | manifest advertises `expectedUpdatedAt` for 40 create/delete tools the SDK rejects |

---

## 1. Error mapping on a real vendor  (F-3 — PASS)

Repro (one script, `maxRetries: 0` so each case is a single request):
```
node /tmp/err-probe.mjs   # 401 bad key, 404 missing id, 404 missing path, 400 ?search=, 429 stub
```
Observed (live vendor unless noted):

| Case | class | code | category | retryable | httpStatus | resourceIds | suggestedAction | correlationId | vendor message |
|------|-------|------|----------|-----------|------------|-------------|-----------------|---------------|----------------|
| 401 bad key | `UnauthorizedError` | `UNAUTHORIZED` | `auth` | false | 401 | — | "Check the API key and its scopes." | set | "Bad credentials" |
| 404 missing id | `NotFoundError` | `NOT_FOUND` | `not_found` | false | 404 | `[99999999]` | "Verify the id, or resolve the record by name first." | set | "Resource not found" (+`details`) |
| 404 missing path | `NotFoundError` | `NOT_FOUND` | `not_found` | false | 404 | — | "Verify the id, or resolve the record by name first." | set | "Not Found" |
| 400 rejected filter | `BadRequestError` | `BAD_REQUEST` | `validation` | false | 400 | — | "Fix the request payload; see the vendor error for the offending field." | set | "search is not a valid filter parameter." |
| 429 (local stub) | `RateLimitError` | `RATE_LIMIT` | `rate_limit` | **true** | 429 | — | "Retry after the Retry-After delay." | set | "Rate limited (HTTP 429)", `retryAfter: 2` |

- Every error carries `correlationId`, `operation` (set by the resource layer, e.g. `companies.get`),
  `httpStatus`/`status`, `category`, `retryable`, `suggestedAction`, and the raw vendor `body`.
- The vendor **does** reject `?search=` on `ip_addresses` with HTTP 400 (confirmed live).
- 429 was **simulated** with a local stub (polite — no tenant hammering); the SDK parsed `Retry-After: 2`
  into `retryAfter: 2` and set `retryable: true`. A real vendor 429 could not be provoked without
  hammering, so its exact vendor body is **UNVERIFIED** (the mapping path is identical to the stub).

**Verdict:** the structured-error contract is implemented correctly and completely. No bug.

## 2. Retry / timeout behaviour  (F-4 — PASS)

Repro: `node /tmp/retry-probe.mjs` (local HTTP stubs; request counts from the stub).

| Scenario | maxRetries | requests made | outcome |
|----------|-----------|---------------|---------|
| 429,429,200 | 3 | 3 | succeeds (retries 429) |
| 500,500,200 | 3 | 3 | succeeds (retries 5xx) |
| 400 always | 3 | **1** | fails `BAD_REQUEST`, `retryable:false` (does NOT retry 4xx) |
| 429 always | 2 | 3 | exhausts → `RATE_LIMIT`; error.correlationId === audit.correlationId, 1 audit event |
| never-responds, timeoutMs=600 | 0 | — | throws `HuduNetworkError` `category:timeout` in **604ms** (not a hang) |
| unreachable `127.0.0.1:9` | 0 | — | throws `HuduNetworkError` `category:network`, `retryable:true` |

- **correlationId reuse:** generated once per call (single `randomUUID()` in `request()` before the
  retry loop in `execute()`); verified live that a retried call's thrown error and its single audit
  event share the same correlationId.
- **Nuance (accurate, not a bug):** the SDK's *internal* retry is **response-based** (429/5xx only).
  Network/timeout errors (fetch throws) are **not** internally retried — they are thrown immediately
  but marked `retryable: true` so a *caller* can safely re-invoke. So "retries 429/5xx, never 4xx"
  is correct; "retries network" is true only in the sense of the `retryable` flag, not an internal loop.
- The timeout path is **simulated** (local never-responding stub + black-hole port); the mapping is
  the same code path the live vendor would hit.

**Verdict:** retry/timeout behaviour is correct. No bug.

## 3. onAudit  (F-5 — PASS, with F-1 gap)

Repro: `node /tmp/audit-probe.mjs` (live vendor).

- Fires **exactly once per call** on success (1 event) AND failure (1 event), and once even when the
  call retries (1 event for a `maxRetries:3` 404).
- Carries: `correlationId`, `operation`, `method`, `path`, `effect`, `dryRun`, `outcome`, `timestamp`,
  and on error `httpStatus` + `resourceIds`; `query` when the request had any.
- **No key leak:** with the real key configured, `JSON.stringify(audit).includes(REAL_KEY) === false`.
  The event is passed through the same `redact()` used for logging.
- **Gap (F-1):** the event has **no `durationMs`** (the SDK never measures call duration) and **no
  `status`** field — it has `outcome` (`success`|`error`) and `httpStatus` (error only) instead.
  C31 checks `e.durationMs` and `e.status`, so it fails.

## 4. redact() and the logger  (F-6 — PASS after rebuild)

Repro: `node /tmp/audit-probe.mjs` (redact section) + `node /tmp/redact-probe.cjs`.

- After rebuild, `redact()` masks **every** credential spelling: `apiKey`, `api_key`, `API_KEY`,
  `x-api-key`, `password`, `otp_secret`, `token`, `secret`, `authorization`, `client_secret`,
  `private_key`, and the `_token`/`_secret`/`_password` suffixes (`session_token`, `db_password`,
  `auth_secret`). Safe fields (`keep`, `name`, `id`, nested `safe`) are preserved; the input is not
  mutated. `isCredentialKey` correctly rejects `name`/`id`/`updatedAt`/`notes`.
- The **only** redact failure in this run was the stale dist (F-0): the old `isCredentialKey` did not
  normalize separators, so `apiKey` (→ `apikey`) was not in the set (which held `api_key`) and leaked.
- **Minor observation (LOW):** the audit event's `query` is redacted by **key-shape only**, so a
  search *term* (e.g. `search: "hunter2"`) is **not** masked (the key `search` is not credential-shaped).
  The logger deliberately logs the path only (never the query), but the audit event includes the query.

## 5. MCP end-to-end  (F-7 — PASS, with F-8 manifest bug)

Repro: `node /tmp/mcp-full.mjs` (spawns `node examples/mcp-server.ts`, MCP stdio JSON-RPC).

- Server starts, negotiates protocol `2025-11-25`, reports `hudu-mcp` v0.3.0, exposes **20 tools**.
- 6 tool calls, all correct:

| Tool | kind | result | size |
|------|------|--------|------|
| `hudu_get_company` `{identifier:3}` | read | compact `CompanySummary` (id/name/slug/website/…) | 379B |
| `hudu_resolve_any` `{identifier:"Microsoft Corporation"}` | resolve | `hits[]` + `total`/`truncated`/`scanned` | 504B |
| `hudu_create_company` `{data:{name},dry_run:true}` | dry-run mutation | `simulated:true`, impact, checks — **no write issued** | 483B |
| `hudu_get_company_context` `{id:3}` | helper | company + bounded assets/articles/websites/passwords | 1981B |
| `hudu_search_across_resources` `{query:"Microsoft"}` | operations | cross-resource `hits[]` | 501B |
| `hudu_get_company` `{identifier:99999999}` | error | `isError:true`, `{"error":true,"code":"NOT_FOUND","status":404,…}` | 143B |

- **LLM-usability:** results are bounded (compact summaries, `limit` default 25 / cap 100), small
  (≤2KB), and paired with `structuredContent` + `outputSchema`. Errors surface `HuduError.code` +
  HTTP status so a model can self-correct. No truncation, no crash.
- **Naming nuance (minor):** `hudu_get_company` is named "get" but performs a *resolve* (id/name/slug/
  domain); the description states this, so it is not misleading in practice.

### F-8 — manifest over-advertises `expectedUpdatedAt` (MEDIUM)

The 147-tool `MCP_TOOL_MANIFEST.md` advertises `opts.expectedUpdatedAt` for **40 create/delete tools**
(18 `create` + 20 `delete` + 1 `deleteAll` + 1 `deleteById`), but the SDK **refuses** `expectedUpdatedAt`
on create/delete/archive (throws `CONFIG_ERROR`). Verified live:

```
companies.create({name}, {expectedUpdatedAt})  -> CONFIG_ERROR "createOne: expectedUpdatedAt is not supported on create/delete/archive"
companies.delete(id, {expectedUpdatedAt})      -> CONFIG_ERROR "deleteOne: expectedUpdatedAt is not supported on create/delete/archive"
companies.archive(id, {expectedUpdatedAt})     -> CONFIG_ERROR "setArchived: expectedUpdatedAt is not supported on create/delete/archive"
```

- Root cause: the `MutationOptions` type includes `expectedUpdatedAt` for **all** mutations, and the
  manifest generator propagates it to create/delete tools. Only `update` (22 tools) legitimately supports it.
- The manifest is **internally inconsistent**: `hudu_create_company` (in the 20-tool MCP server) correctly
  omits it, but `hudu_create_flag`/`create_folder`/etc. advertise it.
- Impact: an LLM following the manifest would pass `expectedUpdatedAt` to a create/delete tool and hit a
  `CONFIG_ERROR`. **Suggested fix:** split `MutationOptions` into `CreateOptions`/`UpdateOptions`/`DeleteOptions`
  (only `UpdateOptions` carries `expectedUpdatedAt`), regenerate the manifest, and re-run `mcp:project --check-example`.

## Cleanup verification

- Final `companies.listAll()` → **21 rows** (unchanged from baseline); **zero** `ZZ`/`Smoke`/`Probe` strays.
- Pre-existing data intact: 2 websites (`https://google.com`, `https://democorp.com.au`), 1 group
  (`Default Group`), 1 user (`user@example.com`).
- The only mutation probe was a **dry-run** create (`simulated:true`, zero HTTP writes); every error probe
  threw before any write. Nothing to delete.

## Could not test (UNVERIFIED)

- **Real vendor 429 body:** could not be provoked without hammering the tenant; the 429 mapping was
  verified against a local stub (identical code path). The exact vendor 429 payload is UNVERIFIED.
- **Live 5xx:** the vendor did not return a 5xx during this run (C38's earlier 500 was transient); the
  5xx retry path was verified against a local stub.
- **MCP tools 21–147:** only the 20 core-tier tools are exposed by `examples/mcp-server.ts`; the other
  127 manifest tools were sampled statically (schema scan) but not invoked live.
