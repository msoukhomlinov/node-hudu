# feat: honour HTTP-date `Retry-After` + rate-limit introspection

Branch: `feat/agent-execution-layer` — no branch switch, no commit, no push.
Files touched: `src/http.ts` (+110/-1), `test/http.test.ts` (+168), `src/client.ts` (+13).

> NOTE for the coordinator: task 2 requires a getter ON `HuduClient`, which lives in `src/client.ts`.
> That file was **not** in my ownership list, so I made the smallest possible ADDITIVE change there
> (one `import type` + one delegating method, 13 lines, nothing reordered or reformatted). If the
> owner of `src/client.ts` edits it concurrently, the change is a single trailing method — trivial to
> re-apply. No generated file was touched.

## Summary

| # | Change | File | Public surface |
|---|--------|------|----------------|
| 1 | `retryAfterSeconds()` parses delta-seconds AND HTTP-date (RFC 7231) | `src/http.ts` | internal — no signature/return-shape change |
| 2 | `client.getRateLimitStatus()` read-only limiter/queue snapshot | `src/http.ts` + `src/client.ts` | ADDITIVE (new method + new `RateLimitStatus` type) |

## TASK 1 — HTTP-date `Retry-After`

### What was wrong
`retryAfterSeconds()` did `Number(header)`. An HTTP-date is not numeric, so the value became `NaN`,
the caller read that as "no hint", and the transport fell back to exponential backoff
(`200ms * 2**attempt`) — which at attempt 0 (200–250ms with jitter) is usually SHORTER than the delay
the server asked for, so we retried before we were told to.

### New behaviour (both RFC 7231 forms)
- delta-seconds: unchanged path — `Number(header)` first, so integers, fractional values and
  whitespace-padded values behave exactly as before (`'5'` → 5, `'0.5'` → 0.5, `''` → 0).
- HTTP-date: `Date.parse(header)`; the delay is `Math.max(0, (when - now) / 1000)` — a date in the
  past clamps to 0 ("retry now"), never a negative sleep.
- Neither form parses → `undefined`, so the backoff path is byte-for-byte unchanged.
- The cap (`MAX_RETRY_DELAY_MS = 30_000`), the `>= 0` floor, the jitter and the whole-call deadline
  clamp in `retryDelayMs` / `execute` are untouched.
- `retryAfterSeconds(header, now = Date.now())` gained an OPTIONAL second parameter for deterministic
  tests. It is module-private, so no public surface moved.

### Evidence — BEFORE (unmodified tree, `git archive HEAD` → `/tmp/nh-before`)
```
$ cd /tmp/nh-before && npx vitest run test/http.test.ts -t "HTTP-date"
 ✓ keeps the existing delta-seconds behaviour (integer and fractional) 18ms
 × converts an HTTP-date Retry-After into a delta from now 3ms
 × clamps an HTTP-date Retry-After in the past to 0 (retry now, not never) 2ms
 ✓ treats an unparseable Retry-After as absent so the backoff path is unchanged 0ms
 × waits out an HTTP-date Retry-After instead of the shorter exponential backoff 233ms
AssertionError: expected RateLimitError: Rate limited (HTTP 429) { …(11) } to match object { retryAfter: +0 }
AssertionError: expected 232 to be greater than or equal to 650
     Tests  3 failed | 2 passed | 61 skipped (66)
```
The 232ms is the bug made visible: the pre-change transport slept ~200ms (exponential, attempt 0)
although the header asked for a date ≥700ms away.

### Evidence — AFTER
```
$ npx vitest run test/http.test.ts
 Test Files  1 passed (1)
      Tests  66 passed (66)
     ✓ waits out an HTTP-date Retry-After instead of the shorter exponential backoff 1250ms
```
(the same test asserts `elapsed >= 650`, so the honoured date delay dominates the 200ms backoff).

Covered cases (all in `test/http.test.ts`): delta-seconds integer + fractional; date 30s in the future
(`retryAfter` in (25, 30]); date 60s in the past → `retryAfter: 0`; junk (`'very soon, please'`) →
`retryAfter: undefined` and the request still retries on the normal backoff; end-to-end timing test.

**LIVE tenant: NOT ATTEMPTED (UNVERIFIED).** I did not provoke a 429 on the live tenant — the
retry path would itself issue extra requests, and other agents were running live tests in this
checkout at the same time. All four cases above are proven with stubs instead.

## TASK 2 — `client.getRateLimitStatus()`

### What the limiter really tracks (no invented numbers)
`HttpClient` keeps a token bucket (`tokens`, `lastRefill`, `capacity`, `refillPerMs`), a serialised
acquisition chain (`consumeTail`), the config, and the audit/log hooks. It previously exposed NONE of
that. I added two counters that report state the transport genuinely has, and read the bucket without
mutating it:
- `inFlight` — incremented before `execute()` and decremented in a `finally`, so it counts requests
  genuinely in the transport **including their retries and backoff sleeps**. Dry runs are excluded
  (they never reach the transport).
- `queued` — incremented in `consumeToken()` and decremented when the caller gets its turn. It counts
  callers waiting for a token (queue + refill wait). Only tracked when a limiter is configured: with
  no bucket the chain resolves immediately, so there is no queue to report.
- `lastRetryAfterSeconds` — set only when the transport actually WAITED for a `Retry-After` hint.

### Shape (small, documented, plain object, synchronous)
```ts
export interface RateLimitStatus {
  readonly enabled: boolean;                     // a token bucket is configured
  readonly throttled: boolean;                   // enabled AND no whole token right now
  readonly availableTokens: number;              // refill applied AT READ TIME (may be fractional); 0 when disabled
  readonly burst: number;                        // bucket capacity; 0 when disabled
  readonly queued: number;                       // callers waiting for a limiter token
  readonly inFlight: number;                     // requests in progress (retries included)
  readonly lastRetryAfterSeconds?: number;       // last Retry-After hint actually honoured
}
```
`HuduClient.getRateLimitStatus(): RateLimitStatus` delegates to the transport. It is synchronous
(the state is local), side-effect free (the refill is applied to the RETURNED estimate only), and
mutates nothing — a getter can never acquire or spend capacity.

### Unit tests
Fresh `HttpClient` with no limiter (exact object equality, and no `.then` → provably not a promise);
fresh client with `{ perMinute: 60, burst: 3 }`; after a call that hits a 429 and retries (tokens
dropped, `throttled: true`, `lastRetryAfterSeconds: 0.01`); an in-flight request observed from a
gated fetch stub (1 while pending, 0 after); repeated reads never spend a token; and `HuduClient`
delegation for a plain and a rate-limited client.

## Gates (all green)

| Gate | Command | Result |
|------|---------|--------|
| typecheck | `npx tsc --noEmit` | 0 — `TSC_OK` |
| lint | `npm run lint` | 0 — `LINT_OK` |
| tests | `npm test` | `Test Files 50 passed (50)` / `Tests 1661 passed (1661)`, 0 failures |
| coverage | `npm run test:coverage` | All files 99.31 stmts / 92.74 branch / 99.89 funcs / 99.66 lines (thresholds 97/83/94/97 — not lowered) |
| capabilities | `node scripts/check-capabilities.mjs` | `PASS — 0 failures; rows=225 scoped=225 registryRecords=225 warnings=66` (warnings are pre-existing `unplanned-surface` entries in resources, none for this change) |
| build | `npm run build` | tsup dual ESM+CJS + `.d.ts`/`.d.cts` emitted, no errors |

## Test-honesty statement
No existing test was weakened, skipped, edited or deleted. The pre-existing `Retry-After: 5`,
`Retry-After: 0.01`, `Retry-After: 0.5` and absent-header tests pass unchanged — no test encoded the
buggy NaN behaviour, so nothing had to be reconciled. New coverage is appended in a new
`describe` block in `test/http.test.ts`.

Files owned by other agents (`src/errors.ts`, `test/errors.test.ts`) were left untouched; my working
tree changes for this task are `src/http.ts`, `test/http.test.ts`, `src/client.ts`.
