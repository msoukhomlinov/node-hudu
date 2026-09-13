# Xref: `WYRE-AI/node-hudu` vs our `node-hudu`

- **Date:** 2026-09-13
- **Target:** `https://github.com/WYRE-AI/node-hudu` — cloned read-only to `/tmp/wyre-node-hudu`
  (`git clone --depth 50`, HEAD `3471266`, package version `1.0.4`).
- **Ours:** `/Users/maxs/gitrepos/node-hudu` @ `feat/agent-execution-layer`, v0.3.0. **Read only.** No build, no test,
  no stage, no commit was run in our worktree.
- **STATUS: COMPLETE** (some items marked UNVERIFIED — see §7).

---

## 0. LICENCE (approval criterion)

`LICENSE` (11345 bytes) is the verbatim **Apache License, Version 2.0**, January 2004. The APPENDIX boilerplate is
filled in as:

```
   Copyright 2026 Wyre Technology

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0
```

`package.json` agrees: `"license": "Apache-2.0"`. There is **no** `NOTICE` file.

**VERDICT: copying code from this repo into ours IS legally clean.** Apache-2.0 is permissive and
one-way compatible with our MIT licence. Conditions if we copy (not just re-implement):

1. Ship a copy of the Apache-2.0 licence text (or a NOTICE) covering the copied files.
2. Mark modified files with a prominent "changed" notice (Apache-2.0 §4(b)).
3. Retain the copyright/attribution notices for the copied portions (we would add
   `Portions copyright 2026 Wyre Technology, Apache-2.0` to the file header and to our NOTICE/CREDITS).

There is **no GPL/AGPL and no unlicensed code** here, so no candidate is downgraded to idea-only on legal grounds.
For the small candidates below I still recommend **re-implement-as-idea**: they are 8–40 lines, and a clean
re-implementation avoids carrying a third-party attribution obligation for trivial logic.

---

## 1. RANKED CANDIDATES

| # | Candidate | Class | Effort | Risk vs our constraints | Licence | Rec |
|---|-----------|-------|--------|-------------------------|---------|-----|
| 1 | Unmocked-request = test failure | (a) absent | S | none (dev-only, 0 deps) | Apache-2.0, clean | **re-implement as idea** |
| 2 | HTTP-date `Retry-After` parsing | (a) absent | XS | none | Apache-2.0, clean | **re-implement as idea** |
| 3 | Normalized field-level validation errors | (a) absent | S | additive-only surface (new optional field) | Apache-2.0, clean | **re-implement as idea** |
| 4 | Rate-limit / backoff introspection | (a) absent | S | additive-only surface (new getter) | Apache-2.0, clean | **re-implement as idea** |
| 5 | Dependabot grouping + TS-major hold | (a) absent | S | none (repo config only) | Apache-2.0, clean | **copy config** (trivial to re-derive) |
| 6 | semantic-release + CI release job | (a) absent | M | none in code; **process** risk | Apache-2.0, clean | **re-implement as idea** |
| 7 | msw network-layer integration tests | (a) absent | M | adds heavy devDep; zero-runtime-deps intact | Apache-2.0, clean | **skip** (candidate 1 captures most value) |

---

### Candidate 1 — Unmocked-request = test failure  *(best candidate)*

**WHAT.** `tests/setup.ts`:

```ts
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
```

with `tests/mocks/server.ts` (`setupServer(...handlers)`) and the full handler table in
`tests/mocks/handlers.ts` (one `http.<verb>(\`${BASE_URL}/api/v1/...\`)` entry per endpoint, each returning a
`tests/fixtures/index.ts` object). MSW intercepts at the network layer, so the **real** `fetch`/undici path runs,
and any request to a URL with no declared handler **fails the test** instead of silently succeeding.

**WHY IT IS BETTER THAN OURS.** Our equivalent is `test/helpers.ts:stubFetch()` /
`stubFetchAny()`:

```ts
export function stubFetchAny(): FetchSpy {
  return stubFetch(() => json({}));
}
```

`vi.stubGlobal('fetch', ...)` replaces fetch with a function that never validates anything. Two real holes follow:

- **Undeclared URL = silent pass.** Any test using `stubFetchAny()` (or a handler that ignores `url`) passes even if
  the client requests the wrong path. Nothing fails when a new resource adds a call to an unmocked endpoint.
- **Malformed `RequestInit` = silent pass.** A stubbed fetch cannot reject an illegal header name, a body on a `GET`,
  or a URL that `new Request(url, init)` would refuse. Real undici would throw; our stub returns `json({})`. Our
  `RequestOptions` builds headers (`Content-Type`, `Accept`, `authorization`), `formUrlEncoded` bodies and
  `manualRedirect` — exactly the shapes only a real fetch validates.

**EFFORT + RISK.** Small, dev-only, no new dependency:
1. Give `stubFetch()` a declared-route set and make an unmatched URL **throw** (mirrors `onUnhandledRequest:'error'`).
2. Add one test that constructs `new Request(url, init)` from the captured call — real undici validation of the
   header/body shape, with no msw.
No collision with zero runtime deps (tests are not shipped), node >= 18, dual ESM+CJS, additive-only public surface,
or coverage thresholds.

**LICENCE.** Apache-2.0 — clean. The idea (fail on unmocked request) is not copyrightable; no attribution needed.

**RECOMMENDATION: re-implement as idea.** One behaviour, zero deps, closes a genuine "green suite hides a wrong URL"
hole that our stubbed-fetch design cannot see.

---

### Candidate 2 — HTTP-date `Retry-After` parsing

**WHAT.** `src/rate-limiter.ts:90-111`:

```ts
  parseRetryAfter(retryAfterHeader: string | null): number {
    if (!retryAfterHeader) return this.config.retryAfterMs;
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds)) return seconds * 1000;
    try {
      const date = new Date(retryAfterHeader);
      const delay = date.getTime() - Date.now();
      if (delay > 0) return delay;
    } catch { /* Ignore parsing errors */ }
    return this.config.retryAfterMs;
  }
```

with a test at `tests/unit/rate-limiter.test.ts:83-88` (`'should parse HTTP date'`, asserting the result lands in
`(25_000, 30_000]` for a `toUTCString()` value 30 s ahead).

**WHY IT IS BETTER THAN OURS.** Our parser handles **seconds only** (`src/http.ts:112-116`):

```ts
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}
```

RFC 7231 defines `Retry-After` as *either* delta-seconds *or* an HTTP-date. A Hudu response (or any intermediary)
sending `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` makes us return `undefined` at `src/http.ts:399`, so we discard
the server's instruction and fall back to exponential backoff — which can retry **earlier than the server asked**,
earning another 429 and burning retry budget. Their test proves the gap is real and testable.

**EFFORT + RISK.** Extra-small: ~10 lines in `retryAfterSeconds`, returning `undefined` when the parsed date is in
the past (never a negative sleep), plus one test. No constraint collision. Must preserve our existing cap
(`MAX_RETRY_DELAY_MS`) and jitter behaviour, and must not change `retryAfterSeconds`'s signature (internal only).

**LICENCE.** Apache-2.0 — clean. A 6-line date branch is not worth an attribution obligation.

**RECOMMENDATION: re-implement as idea.** Cheapest correctness fix on this list; strictly widens the set of
server instructions we honour.

---

### Candidate 3 — Normalized field-level validation errors

**WHAT.** `src/errors.ts:42-51`:

```ts
export class HuduValidationError extends HuduError {
  readonly errors: Array<{ field: string; message: string }>;
```

filled by `src/http.ts:178-196` `parseValidationErrors()`, which tolerates vendor key aliases
(`e['field'] ?? e['property']`, `e['message'] ?? e['error']`) and falls back to `{field:'unknown', message:String(err)}`.
Triggered on 400 and 422 (`src/http.ts:110-135`). README documents it: `console.error('Validation failed:', error.errors)`.

**WHY IT IS BETTER THAN OURS.** Our `ValidationFailedError` (`src/errors.ts:221-226`) carries `vendorError` (the raw
body) and a `suggestedAction` string, but **no normalized field list**. A caller — especially an LLM tool caller in an
MCP server — cannot answer "which field did I get wrong?" without re-parsing vendor JSON whose shape we do not own.
Their alias-tolerant extraction is a small, tested normalization we lack.

**EFFORT + RISK.** Small: add an optional `fields?: Array<{ field: string; message: string }>` to our validation
error (and to `HuduErrorOptions`), populate it from the vendor body in `errorFromStatus`, and cover it in
`test/errors.test.ts` + `test/http.test.ts`. **Collides with additive-only public surface** — an *optional* new
property is additive, so the guard in `test/public-surface.test.ts` still passes; a required property would not.
Watch the 97/94/83/97 thresholds: the new branch needs tests, including the malformed-body path.

**LICENCE.** Apache-2.0 — clean; re-implement (their class shape, `statusCode: 400` hardcoded, is one we must NOT
copy — see §3).

**RECOMMENDATION: re-implement as idea.** Concrete gap, small additive surface change.

---

### Candidate 4 — Rate-limit / backoff introspection

**WHAT.** `src/client.ts:59-64`:

```ts
  getRateLimitStatus(): { remaining: number; rate: number } {
    return {
      remaining: this.rateLimiter.getRemainingRequests(),
      rate: this.rateLimiter.getCurrentRate(),
    };
  }
```

backed by `src/rate-limiter.ts:66-77` (`getCurrentRate()`, `getRemainingRequests()`), documented in README under
"Rate Limit Status".

**WHY IT IS BETTER THAN OURS.** Our `HuduClient` exposes resources, `operations` and `readonly config` — and **no**
view of the limiter. A caller cannot ask "how much budget is left before I get throttled?". For our MCP/agent layer
that is exactly the signal an agent needs before deciding to fan out a bulk helper, and it is the honest way to
surface our own backpressure instead of letting a caller discover it as latency. We also do **not** read any
server-side rate-limit headers (`grep -n ratelimit src/http.ts` returns only `retry-after`), so today neither the
server's nor our own budget is observable.

**EFFORT + RISK.** Small: one additive read-only accessor on the client, derived from the existing token bucket
(`src/http.ts:217-230`), plus tests. **Additive-only public surface** is satisfied by a new method. Do not adopt
their default-on limiter or their `rate`-as-a-fraction semantics — expose our token bucket's real state
(available tokens, capacity, ms until next refill) and mark the shape clearly. **UNVERIFIED:** whether Hudu sends
`X-RateLimit-*` headers; if it does, reading them is a strictly better source than our local estimate.

**LICENCE.** Apache-2.0 — clean; re-implement (our bucket, not their sliding window).

**RECOMMENDATION: re-implement as idea.** Low cost, real value for the agent layer.

---

### Candidate 5 — Dependabot grouping + explicit TypeScript-major hold

**WHAT.** `.github/dependabot.yml`: weekly npm + `github-actions` updates, `groups:` collapsing all
`development` updates (incl. majors) into ONE PR and production minor+patch into another, plus a deliberate,
commented hold:

```yaml
    ignore:
      # typescript 7.x breaks this fleet's toolchain: DTS emit (tsup/rollup-plugin-dts
      # TS5101 baseUrl-deprecated-as-error), and typescript-eslint (still <6.1.0 as of
      # 8.66.0, no TS7 support yet). Has broken main 3x on some repos because Dependabot
      # has no memory of a prior manual revert and just re-proposes the same major again.
      - dependency-name: "typescript"
        update-types: ["version-update:semver-major"]
```

**WHY IT IS BETTER THAN OURS.** Our repo has **no `.github` directory at all** — no Dependabot, no CI workflow
(verified: `ls .github` → `No such file or directory`). We have 15+ devDependencies on a TS/tsup/vitest/eslint
toolchain that does break on majors. Their config is a concrete, battle-scarred policy (grouped PRs, explicit
rationale for the hold) that we can adopt verbatim as configuration.

**EFFORT + RISK.** Small, repo-config only. No collision with zero runtime deps, node >= 18, dual build, public
surface or coverage. The only judgement call: our toolchain pins differ (we are TS 5.7 / eslint 9; theirs is
TS ^6.0.3 / eslint ^10), so copy the *policy*, not their version numbers.

**LICENCE.** Apache-2.0 — clean; config files, and trivial to re-derive.

**RECOMMENDATION: copy config** (or re-derive; equivalent either way). Highest-value non-code item, because we
currently have no automated dependency hygiene at all.

---

### Candidate 6 — semantic-release + gated CI release job

**WHAT.** `.releaserc.json` (`commit-analyzer` → `release-notes-generator` → `changelog` →
`npm` → `git` (assets `package.json`, `CHANGELOG.md`, message `chore(release): ${nextRelease.version} [skip ci]`) →
`github`), driven by `.github/workflows/ci.yml`: a `test` job on a node matrix, then a `release` job with
`needs: test`, `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`,
`permissions: {contents: write, packages: write}` and `npx semantic-release`. Their `CHANGELOG.md` is entirely
machine-generated from conventional commits (`fix:`, `feat:`, `chore(release):` entries with commit links).

**WHY IT IS BETTER THAN OURS.** We have no CI and no release automation in this worktree. Their setup guarantees:
release only after green tests, changelog derived from commit types, version bump computed rather than hand-picked.
Our repo already uses conventional-ish prefixes in history, so the input format is compatible.

**EFFORT + RISK.** Medium, and the risk is **process, not code**: it needs publish credentials (`NPM_TOKEN`/
`GITHUB_TOKEN`) and it *replaces* whatever release flow we use today — **UNVERIFIED: our current publish process,
registry (their `publishConfig.registry` is `https://npm.pkg.github.com`; ours is not set) and whether 0.x
semantics matter.** Do not land this blind. No collision with zero runtime deps / node >= 18 / dual build /
public surface / coverage thresholds.

**LICENCE.** Apache-2.0 — clean; re-derive.

**RECOMMENDATION: re-implement as idea, as a separate decision.** Real value, but it touches our release process
and needs owner sign-off.

---

### Candidate 7 — msw network-layer integration testing (full harness)

**WHAT.** `tests/mocks/server.ts` + `tests/setup.ts` + `tests/mocks/handlers.ts` (≈265 lines of handlers covering
all 11 resources) + `tests/fixtures/index.ts` (per resource: `list` / `single` / `created` / `updated` shapes), with
`msw` as a devDependency (`^2.15.0`). Tests override per-case: `server.use(http.get(url, () => HttpResponse.json(..., {status: 401})))`
(`tests/integration/http.test.ts:23-41`).

**WHY IT IS BETTER THAN OURS.** It exercises the real `fetch`/undici path and shares one fixture set between
handlers and assertions. That is genuinely better than a `vi.stubGlobal('fetch')` seam — but candidate 1 captures
the load-bearing part (undeclared URL fails; a real `Request` validates the init) at zero dependency cost.

**EFFORT + RISK.** Medium. `msw` is dev-only, so our **zero-runtime-deps** rule is *not* broken; but it adds a
heavy dev dependency, globally patches undici in the test process, and would need a rewrite of our existing
`test/helpers.ts` seam across 50 test files. Their bleeding-edge devDeps (eslint ^10, typescript ^6.0.3,
`@types/node` ^26) would collide with our pinned toolchain.

**LICENCE.** Apache-2.0 — clean.

**RECOMMENDATION: skip** the dependency; take only the "fail on unmocked request" behaviour (candidate 1).

---

## 2. (a) GENUINELY ABSENT IN OURS

Candidates 1–6 above. Concretely: no unmocked-request test guard; no HTTP-date `Retry-After`; no normalized
field-level validation detail; no rate-limit introspection; no `.github` (Dependabot/CI/release automation) at all.

Also absent, and *not* worth adopting: their `requestUrl<T>(url)` absolute-URL GET helper (`src/http.ts:55-57`) —
we already cover redirect/absolute-URL needs with `manualRedirect`.

## 3. (b) THINGS WE HAVE BUT THEIRS DOES BETTER

**Almost nothing — this section is deliberately near-empty.** Their SDK is ~3,710 lines of TypeScript across 66
files covering **11 resources**; ours covers **34 resources** plus a 225-operation capability registry, an MCP tool
manifest, the helper tier, dry-run/impact previews, `expectedUpdatedAt` guards, structured errors, the audit hook
with redaction, and the additive-only surface guard. Their runtime is a thin REST wrapper.

The only honest entries:

- **Test-seam strictness** (their msw `onUnhandledRequest: 'error'`) — already listed as candidate 1.
- **Per-resource fixture completeness** — `tests/fixtures/index.ts` gives every resource a uniform
  `list/single/created/updated` set. **UNVERIFIED** whether our `test/fixtures` + `test/__fixtures__` cover the same
  four shapes per resource.
- **README rate-limit docs** — their README inlines every `RateLimitConfig` default with its meaning. Ours documents
  a *larger* surface, so this is presentation parity, not a capability gap.

## 4. (c) THINGS THEIRS DOES THAT WE SHOULD NOT ADOPT

1. **Method-agnostic retry — this would break our contract.** `src/http.ts:137-148` retries on 429 and
   `src/http.ts:150-161` retries once on 5xx **regardless of HTTP method**, recursively re-issuing `executeRequest`
   with the same body. A POST that created a record can be replayed → duplicate writes. We deliberately never retry
   POST (`RequestOptions.retries` doc: "POST is never retried"). **Do not adopt.**
2. **`{} as T` fabrication.** `src/http.ts:90-99`: `204` returns `{} as T`, and a `200` with a non-JSON
   `Content-Type` also returns `{} as T`. This breaks our B3/B4 honesty rule (a non-record body is passed through,
   never fabricated; a wrong list key throws instead of yielding "no results"). **Do not adopt.**
3. **No timeout / `AbortSignal` anywhere in their transport.** Their `fetch` call is bare
   (`src/http.ts:74-78`); a hung request hangs forever. Ours threads a whole-call `timeoutMs` deadline through
   retries, backoff and the token wait. Adopting their transport shape removes that guarantee. **Do not adopt.**
4. **An error object that lies about the status.** `src/http.ts:130-135` constructs
   `new HuduValidationError('Unprocessable entity', [], responseBody)` for a **422**, but the class hardcodes
   `super(message, 400, response)` (`src/errors.ts:45-46`) → `error.statusCode === 400` for a 422 response. Never
   mirror this shape; our errors must key off the real status.
5. **Flat error taxonomy.** 7 classes with `statusCode` + raw `response` only. No `code`, `category`, `retryable`,
   `suggestedAction`, `correlationId`, `resourceIds`, `url`. Adopting it would be a regression against our structured
   error contract.
6. **Default-ON client-side rate limiter.** Their limiter sleeps inside the request path by default (300 req/min,
   `throttleThreshold: 0.8`, `src/rate-limiter.ts:24-51`) — a library that silently delays by default. Our token
   bucket is **opt-in** (`config.rateLimit` doc: "Off by default"). Keep ours opt-in.
7. **No agent-execution layer.** No dry-run, no impact statement, no `expectedUpdatedAt`, no audit hook, no
   capability registry, no MCP tool manifest. Their `HuduClient` shape is a strict subset of ours; adopting it
   wholesale would delete the work in flight on `feat/agent-execution-layer`.
8. **`getConfig(): Readonly<ResolvedConfig>`** hands the plaintext API key to any caller (`src/client.ts:55-57`).
   (Note: our client also exposes `readonly config: ResolvedConfig`, so this is a shared exposure, not a
   differentiator — flagged only so nobody copies it as an *improvement*.)
9. **`engines: ">=18.0.0"` is untested in their CI** — their matrix is `node-version: [22, 24]`. Do not copy their
   matrix; it silently drops our declared floor.
10. **Bleeding-edge devDependencies** (typescript ^6.0.3, eslint ^10, `@types/node` ^26) — collides with our pinned
    TS 5.7 / eslint 9 toolchain, and their own Dependabot comment admits a TS major broke their build 3 times.

**Runtime dependencies:** to be explicit — the "they take a runtime dependency we refuse" case does **not** apply.
Their `package.json` has **no `dependencies` key at all**; every dependency is a devDependency. They are zero-runtime-
dependency too, and use native `fetch`, like us.

## 5. THINGS THAT WOULD BREAK OUR CONTRACTS IF ADOPTED

| Their behaviour | Our contract it breaks |
|---|---|
| Retry 429/5xx for POST (recursive re-issue) | "POST is never retried"; dry-run/impact accounting assumes one write per call |
| `{} as T` for 204 / non-JSON 200 | B3/B4 envelope honesty (pass non-records through; throw on wrong list key) |
| Bare `fetch` with no deadline | whole-call `timeoutMs` deadline + timeout-is-retryable classification |
| `HuduValidationError` = status 400 for a 422 | our status-derived `category` / `retryable` / `suggestedAction` |
| 7-class flat error hierarchy | structured errors (`code`/`category`/`retryable`/`resourceIds`/`correlationId`) |
| Default-on blocking limiter | opt-in `rateLimit`; tests and CLIs must not acquire hidden latency |
| Their `HuduClient` resource-only shape | the agent-execution layer (helpers, registry, MCP manifest, audit) |
| Their devDependency versions | TS 5.7 / eslint 9 pinning; tsup DTS stability |

None of candidates 1–6 breaks a contract: 1 is test-only, 2 is an internal parser, 3 and 4 are *additive* optional
surface, 5 and 6 are repo config.

## 6. WHAT I DID **NOT** INSPECT

- **I did not run their test suite or ours.** Our worktree is being edited by another team; their suite was not run
  either (no install performed).
- `package-lock.json` (334 KB), `CONTRIBUTING.md`, `eslint.config.mjs`, `.github/workflows/claude.yml`,
  `.gitignore` — unread.
- **Per-endpoint type fidelity**: I read `src/types/common.ts`, `src/types/index.ts` and skimmed
  `src/types/*.ts` only through usage. I did **not** compare their 11 resources' field optionality/nullability or
  query-parameter coverage against the Hudu API spec or against ours. UNVERIFIED.
- Their `src/resources/*.ts` beyond `companies.ts` and `assets.ts` (spot-checked only). Note their `listAll` is a
  per-resource copy-paste loop with the same `items.length < pageSize` termination we already have centrally —
  nothing to take.
- Their `tests/fixtures/index.ts` in full (head only) — so the "four fixture shapes per resource" claim is
  UNVERIFIED.
- Their `tests/integration/*.test.ts` beyond `http.test.ts` (head) and `assets.test.ts` (head).
- **Our own CI/publish process** — there is no `.github` in this worktree, but whether CI/release automation lives
  elsewhere (a different branch, or the default branch) is UNVERIFIED. Candidate 6 depends on that answer.
- Whether Hudu emits `X-RateLimit-*` headers — UNVERIFIED (affects candidate 4's design).

## 7. RECOMMENDED ACTION ORDER

1. **Candidate 1** — unmocked-URL + real-`Request` validation in `test/helpers.ts`. Dev-only, no deps, closes a
   silent-pass hole.
2. **Candidate 2** — HTTP-date `Retry-After` in `src/http.ts`. ~10 lines, one test, pure correctness win.
3. **Candidate 3** — optional normalized `fields` on our validation error. Additive; helps tool callers.
4. **Candidate 4** — read-only limiter/backoff introspection accessor. Additive; useful to the MCP layer.
5. **Candidate 5** — Dependabot grouping + explicit TS-major hold. Repo config, no code risk.
6. **Candidate 6** — CI + release automation. **Needs owner sign-off** on the publish process first.

**Single best candidate: Candidate 1.** It is the only item that closes a hole that lets a *wrong* change ship
green, it needs no new dependency, and it collides with none of our constraints.

**Nothing was BLOCKED-BY-ACCESS**: the clone succeeded, and the licence is Apache-2.0 (permissive, copy-clean).
