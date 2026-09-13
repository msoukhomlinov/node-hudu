# feat-test-strictness — a wrong or malformed request now FAILS a test

Status: DONE. `npx tsc --noEmit && npm run lint && npm test` all 0; `npm run build` 0;
`npm run test:coverage` 0 with every file above the configured thresholds (97/94/83/97).
No file under `src/` was touched; no generated file was touched; nothing committed.

Files owned/changed by me:

| File | Change |
|---|---|
| `test/helpers.ts` | shape validation in `stubFetch` (always on) + `expectRequests` (opt-in strict expectations) |
| `test/strict-stub.test.ts` | NEW — 20 tests pinning both mechanisms |
| `test/client.test.ts` | adopted `expectRequests(spy, [])` (constructor must make no request) |
| `test/http.test.ts` | adopted declared expectations in 3 tests |
| `test/resources/companies.test.ts` | adopted declared expectations in 5 tests |
| `.run/live/proof-bad-url.test.ts.txt` | archived source of the temporary red/green proof file |

## 1. Shape validation (applies to every existing test)

`stubFetch(handler, options?)` now validates each stubbed request. A violation is RECORDED on the spy
(`spy.violations`, `spy.drainViolations()`) and THROWN at `clearFetch()` — which every one of the 46
stub-using test files already calls in `afterEach` — so the calling test goes red, with this message
shape (URL, method, reason, test name):

```
Error: Malformed or undeclared stubbed request in test "<suite> > <test>" (1 violation):
  - GET https://hudu.example.com/api/v1/companies/undefined
      [shape] path segment "undefined" means an interpolated id was missing or malformed
```

Rules rejected (`shapeReasons`), each individually pinned by a test:

| Rule | Why it is structurally impossible |
|---|---|
| URL not absolute | a real SDK request always carries scheme+host |
| scheme other than http/https | `new URL` also accepts `ftp:`/`file:` |
| URL does not start with the configured base URL (or a second origin in the same test) | catches the wrong-host / wrong-tenant URL that a `{}`-for-any-URL stub hid |
| `/undefined`, `/NaN`, `/null` path segment | the shipped `GET /companies/undefined/assets` |
| empty path segment (double slash) | lost or doubled slash between base and path |
| `undefined=`/`NaN=`/`null=` as a query name or value | serialized missing value |
| absent/empty `init.method` | a request the caller meant to send, with no verb |

`options` are additive and optional: `{ baseUrl?: string; validateShape?: boolean }`. When no `baseUrl`
is given, the first request's origin becomes the base for the rest of the test, so cross-origin drift is
still caught. `validateShape: false` exists only to assert on a deliberately bad URL (used by the proof
below and by the shape tests themselves).

## 2. Opt-in strict expectations

```ts
const spy = stubFetch(() => json({ company }), { baseUrl: 'https://hudu.example.com' });
expectRequests(spy, [{ method: 'GET', url: 'https://hudu.example.com/api/v1/companies/1' }]);
```

`RequestExpectation = { method; url: string | RegExp; times?: number | 'any' }`. After the declaration:

- a request that matches no declared method+url → violation `unexpected` (with the list of still-open
  declarations in the reason);
- a request that arrives after its declared count is used up → violation `unexpected` (`still open: <none>`);
- a declared request that is never made → violation at `clearFetch()` (`declared request was never made`).

`times` defaults to `1`; `'any'` is for endpoints a test deliberately hammers. Matching is
order-insensitive (counts, not a sequence).

## 3. Adopted in three existing test files (diff)

```diff
--- a/test/client.test.ts
+++ b/test/client.test.ts
-import { clearFetch, stubFetchAny } from './helpers.js';
+import { clearFetch, expectRequests, stubFetchAny, type FetchSpy } from './helpers.js';
 describe('HuduClient', () => {
-  beforeEach(() => stubFetchAny());
+  // Strict: the client constructor must not make a single request, so ANY request fails the test.
+  let spy: FetchSpy;
+  beforeEach(() => {
+    spy = stubFetchAny({ baseUrl: 'https://hudu.example.com' });
+    expectRequests(spy, []);
+  });
   afterEach(() => clearFetch());
   it('wires all 35 resource clients', () => {
-    stubFetchAny();
     const c = makeClient();

--- a/test/http.test.ts
+++ b/test/http.test.ts
-import { clearFetch, stubFetch, json, text, empty, type FetchSpy } from './helpers.js';
+import { clearFetch, stubFetch, json, text, empty, expectRequests, type FetchSpy } from './helpers.js';
   it('sends the x-api-key header', async () => {
-    const spy = stubFetch(() => json({}));
+    const spy = stubFetch(() => json({}), { baseUrl: 'https://hudu.example.com' });
+    expectRequests(spy, [{ method: 'GET', url: 'https://hudu.example.com/api/v1/companies' }]);
   it('sends a JSON body with content-type', async () => {
-    const spy = stubFetch(() => json({ company: { id: 1 } }));
+    const spy = stubFetch(() => json({ company: { id: 1 } }), { baseUrl: 'https://hudu.example.com' });
+    expectRequests(spy, [{ method: 'POST', url: 'https://hudu.example.com/api/v1/companies' }]);
   it('does not set content-type when there is no body', async () => {
-    const spy = stubFetch(() => json({}));
+    const spy = stubFetch(() => json({}), { baseUrl: 'https://hudu.example.com' });
+    expectRequests(spy, [{ method: 'DELETE', url: 'https://hudu.example.com/api/v1/companies/1' }]);

--- a/test/resources/companies.test.ts
+++ b/test/resources/companies.test.ts
-import { stubFetch, json, empty, clearFetch } from '../helpers.js';
+import { stubFetch, json, empty, clearFetch, expectRequests } from '../helpers.js';
   it('get returns the unwrapped company', ...)
+    expectRequests(spy, [{ method: 'GET', url: 'https://hudu.example.com/api/v1/companies/1' }]);
   it('get propagates 404', ...)
+    expectRequests(spy, [{ method: 'GET', url: 'https://hudu.example.com/api/v1/companies/999' }]);
   it('create (raw) posts JSON and returns the raw company', ...)
+    expectRequests(spy, [{ method: 'POST', url: 'https://hudu.example.com/api/v1/companies' }]);
   it('update unwraps the { company } envelope', ...)
+    expectRequests(spy, [{ method: 'PUT', url: 'https://hudu.example.com/api/v1/companies/1' }]);
   it('delete returns void on 204', ...)
+    expectRequests(spy, [{ method: 'DELETE', url: 'https://hudu.example.com/api/v1/companies/1' }]);
```

## 4. Proof

### (a) the shape validator fails on a fabricated bad URL

Command: `npx vitest run test/strict-stub.test.ts`

```
 ✓ records a violation for a fabricated bad URL, naming the URL and the reason
 ✓ flags a relative URL / a foreign origin / a NaN path segment / a null path segment /
   an empty path segment / a NaN query value / an undefined query key / a non-http scheme
 ✓ flags a request sent without a method
 ✓ flags a second origin inside one test even without a configured baseUrl
 ✓ fails the test at clearFetch() when a violation is not inspected
```

The violation record asserted in the first test:

```
kind:      'shape'
url:       'https://hudu.example.com/api/v1/companies/undefined/assets'
method:    ''
reasons:   ['path segment "undefined" means an interpolated id was missing or malformed']
testName:  'stubbed-request shape validation > records a violation for a fabricated bad URL, ...'
```

### (b) a test that used to pass with a wrong URL now fails

Temporary file `test/__proof-bad-url.test.ts` (archived at `.run/live/proof-bad-url.test.ts.txt`,
deleted from the suite afterwards). Same body twice; the first turns validation off to reproduce the
old behaviour, the second is the test as it existed before this change:

```
 ❯ test/__proof-bad-url.test.ts (2 tests | 1 failed)
     ✓ BEFORE-equivalent: shape validation off - the wrong URL still ships green 20ms
     × AFTER: the same test with shape validation on fails on the URL it sent 2ms

 FAIL  ... > AFTER: the same test with shape validation on fails on the URL it sent
Error: Malformed or undeclared stubbed request in test "loose stub, wrong URL > AFTER: ..." (1 violation):
  - GET https://hudu.example.com/api/v1/companies/undefined
      [shape] path segment "undefined" means an interpolated id was missing or malformed
```

Both bodies do the same thing: `client.companies.get(undefined)` under `stubFetchAny()`, which answers
`200 {}` for ANY url, so `expect(res).toEqual({})` held and the test was green while the SDK sent
`GET /api/v1/companies/undefined`. The FIXED version lives in `test/strict-stub.test.ts`
("the same call with a real id declares its URL and passes"): `get(1)` + a declared expectation, and
the recorded call list is asserted to be exactly `GET .../api/v1/companies/1`.

### (c) the suite is still green

```
$ npx tsc --noEmit && npm run lint && npm test
 Test Files  51 passed (51)
      Tests  1681 passed (1681)
$ npm run build                     # exit 0
$ npm run test:coverage             # exit 0, all thresholds met (unchanged 97/94/83/97)
```

Test-count accounting: at the start of my work the suite reported 1631 tests; while I worked, sibling
agents added tests in the same checkout (e.g. `test/errors.test.ts`, `test/http.test.ts` Retry-After
block), so the pre-my-change figure rose to 1661. Final: 1681 = 1661 + my 20 new tests in
`test/strict-stub.test.ts`. No existing test was weakened, skipped, edited or deleted to accommodate
the validator, and the coverage thresholds are untouched in `vitest.config.ts`.

## 5. Breakage report — how many existing tests the strictness broke

**Shape validation broke 0 of the 1661 existing tests** (46 files drive `stubFetch`). That is itself the
finding: today's mocked suite never emits a malformed URL, because a stub that answers `{}` for any URL
also makes the URL unobservable. The bug class is only detectable when either (i) the SDK's own path
building regresses and a shape rule fires, or (ii) a test DECLARES its URL — which is what the adoption
in section 3 adds. So the validator is a net that catches the regression, and declared expectations are
the mechanism that makes today's green tests actually look at where the request went.

**Strict expectations broke 1 test while being adopted — my own copy/paste error**, and it is a good
demonstration of the mechanism firing on a real mistake:

```
 FAIL  test/resources/companies.test.ts > CompaniesResource > get propagates 404
Error: Malformed or undeclared stubbed request in test "..." (2 violations):
  - GET https://hudu.example.com/api/v1/companies/999
      [unexpected] request was not declared by expectRequests(); declared requests still open: GET .../companies/1 (1x)
  - GET https://hudu.example.com/api/v1/companies/1 (1x)
      [extra] declared request was never made (1 of its calls missing)
```

Resolution: the declared URL was corrected to `.../companies/999` (the id the test actually uses). The
declaration was NOT relaxed to a regex or `times: 'any'`.

## 6. Caveats

- Coverage of `test/helpers.ts` is not measured (`coverage.include` is `src/**`); the new helper code is
  fully exercised by `test/strict-stub.test.ts`.
- UNVERIFIED: the cross-origin rule (base inferred from the first request when `baseUrl` is not passed)
  would flag a test that legitimately talks to two hosts in one test. No such test exists today
  (0 breakages); if one is added later it must pass `baseUrl` explicitly or set `validateShape: false`
  with a comment.
- UNVERIFIED-BY-ME: `src/**` in this checkout is being edited concurrently by sibling agents, so the
  suite state I report includes their in-flight tests. My changes are confined to `test/`.
