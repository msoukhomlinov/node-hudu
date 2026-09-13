/**
 * Shared test helpers: mocked global fetch + JSON response builders.
 * Never touches the network.
 *
 * Two layers of strictness, both opt-out only by an explicit flag:
 *  1. SHAPE VALIDATION (always on) - a stubbed request that could never be answered by a real
 *     Hudu tenant (relative URL, foreign origin, `/undefined` path segment, `NaN=` query value,
 *     empty path segment, missing method) is recorded as a violation and fails the test at
 *     `clearFetch()`. The failure names the URL and the test, because a suite that answers
 *     `{}` for any URL cannot notice a wrong URL - and did not, when a literal
 *     `/companies/undefined/...` path segment shipped.
 *  2. STRICT EXPECTATIONS (`expectRequests`) - a test declares the requests it means to make;
 *     any other request, an unmatched method, or an extra call fails the test.
 */
import { vi, expect } from 'vitest';

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Build a JSON Response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Build a plain-text Response. */
export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/** Build an empty 204 Response (or any empty body). */
export function empty(status = 204): Response {
  return new Response(null, { status });
}

export interface SpyCall {
  url: string;
  init: RequestInit;
}

export type ViolationKind = 'shape' | 'unexpected' | 'extra';

export interface StubViolation {
  kind: ViolationKind;
  testName: string;
  url: string;
  method: string;
  /** Human-readable reasons, one per line, already formatted for an assertion message. */
  reasons: string[];
}

/**
 * One declared request. `url` is an exact URL string or a pattern; `times` defaults to 1 and
 * accepts 'any' for "this may happen any number of times".
 */
export interface RequestExpectation {
  method: string;
  url: string | RegExp;
  times?: number | 'any';
}

export interface StubFetchOptions {
  /**
   * Origin (and optional path prefix) the code under test was configured with, e.g.
   * 'https://hudu.example.com'. When omitted, the first request's origin becomes the base for
   * the rest of the test - so a second, different origin is still a violation.
   */
  baseUrl?: string;
  /** Turn shape validation off for this stub (e.g. to assert on a deliberately bad URL). */
  validateShape?: boolean;
}

export interface FetchSpy {
  calls: SpyCall[];
  handler: FetchHandler;
  setHandler(next: FetchHandler): void;
  /** Shape violations + strict-expectation violations recorded for this stub. */
  violations: StubViolation[];
  /** Return the recorded violations and mark them as reported (so `clearFetch` stays quiet). */
  drainViolations(): StubViolation[];
  baseUrl: string | undefined;
  validateShape: boolean;
}

/** Path segments that mean a value was interpolated while undefined/NaN/null. */
const BAD_SEGMENTS = new Set(['undefined', 'NaN', 'null']);
/** Query keys or values that mean a value was serialized while undefined/NaN/null. */
const BAD_VALUES = new Set(['undefined', 'NaN', 'null']);

function currentTestName(): string {
  try {
    return expect.getState().currentTestName ?? '<unknown test>';
  } catch {
    return '<unknown test>';
  }
}

/** Validate one stubbed request against what a real Hudu tenant could answer. */
function shapeReasons(url: string, init: RequestInit | undefined, baseUrl: string | undefined): string[] {
  const reasons: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [`URL is not absolute (no scheme/host): "${url}"`];
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    reasons.push(`URL uses an unsupported scheme "${parsed.protocol}" (expected http/https)`);
  }
  if (baseUrl !== undefined && !url.startsWith(baseUrl)) {
    reasons.push(`URL does not start with the configured base URL "${baseUrl}"`);
  }
  if (/\/(undefined|NaN|null)(\/|$)/.test(parsed.pathname)) {
    const segment = parsed.pathname.split('/').find((s) => BAD_SEGMENTS.has(s));
    reasons.push(`path segment "${segment}" means an interpolated id was missing or malformed`);
  }
  if (parsed.pathname.includes('//')) {
    reasons.push('path contains an empty segment (double slash)');
  }
  for (const [key, value] of parsed.searchParams) {
    if (BAD_VALUES.has(key)) reasons.push(`query parameter name "${key}" is a missing value`);
    if (BAD_VALUES.has(value)) reasons.push(`query parameter "${key}=${value}" carries a missing value`);
  }
  const method = typeof init?.method === 'string' ? init.method.trim() : '';
  if (method === '') {
    reasons.push('request has no HTTP method (init.method is absent/empty)');
  }
  return reasons;
}

function describeExpectation(e: RequestExpectation): string {
  const times = e.times === 'any' ? 'any number of times' : `${e.times ?? 1}x`;
  return `${e.method} ${e.url instanceof RegExp ? e.url.toString() : e.url} (${times})`;
}

interface StrictPlan {
  expected: { spec: RequestExpectation; remaining: number | 'any' }[];
}

/**
 * Install a fetch stub that delegates to `handler` every call.
 * The handler can be swapped later via `setHandler` (used for retry sequences).
 *
 * Every call is shape-validated (see the module comment); violations are recorded and thrown at
 * `clearFetch()`, so the calling test fails instead of passing on a response for the wrong URL.
 */
export function stubFetch(handler: FetchHandler, options: StubFetchOptions = {}): FetchSpy {
  const violations: StubViolation[] = [];
  const state: FetchSpy = {
    calls: [],
    handler,
    setHandler(next: FetchHandler) {
      this.handler = next;
    },
    violations,
    drainViolations() {
      return violations.splice(0, violations.length);
    },
    baseUrl: options.baseUrl,
    validateShape: options.validateShape ?? true,
  };
  spies.push(state);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit) => {
      const call: SpyCall = { url: String(url), init };
      state.calls.push(call);
      const method = typeof init?.method === 'string' ? init.method.toUpperCase() : '';
      if (state.validateShape) {
        if (state.baseUrl === undefined) {
          try {
            state.baseUrl = new URL(call.url).origin;
          } catch {
            // Not absolute: reported by shapeReasons below; no origin to infer.
          }
        }
        const reasons = shapeReasons(call.url, call.init, state.baseUrl);
        if (reasons.length > 0) {
          violations.push({ kind: 'shape', testName: currentTestName(), url: call.url, method, reasons });
        }
      }
      const plan = strictPlans.get(state);
      if (plan !== undefined) {
        const hit = plan.expected.find(
          (e) =>
            (e.remaining === 'any' || e.remaining > 0) &&
            e.spec.method.toUpperCase() === method &&
            matchesUrl(e.spec.url, call.url),
        );
        if (hit === undefined) {
          violations.push({
            kind: 'unexpected',
            testName: currentTestName(),
            url: call.url,
            method,
            reasons: [
              'request was not declared by expectRequests()',
              `declared requests still open: ${
                plan.expected.filter((e) => e.remaining === 'any' || e.remaining > 0).map((e) => describeExpectation(e.spec)).join(', ') || '<none>'
              }`,
            ],
          });
        } else if (hit.remaining !== 'any') {
          hit.remaining -= 1;
        }
      }
      return state.handler(call.url, call.init);
    }),
  );
  return state;
}

function matchesUrl(pattern: string | RegExp, url: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(url);
  return pattern === url;
}

const strictPlans = new WeakMap<FetchSpy, StrictPlan>();
const spies: FetchSpy[] = [];

/**
 * Declare the requests a test means to make. After this call, any request that does not match a
 * declared method+url (or that arrives after its declared count is used up) fails the test, as
 * does a declared request that is never made.
 */
export function expectRequests(spy: FetchSpy, expected: readonly RequestExpectation[]): FetchSpy {
  strictPlans.set(spy, { expected: expected.map((spec) => ({ spec, remaining: spec.times ?? 1 })) });
  return spy;
}

function formatViolations(violations: StubViolation[]): string {
  const lines = violations.map((v) => {
    const head = v.method === '' ? v.url : `${v.method} ${v.url}`;
    return `  - ${head}\n      [${v.kind}] ${v.reasons.join('; ')}`;
  });
  return lines.join('\n');
}

/**
 * Report the requests that were declared but never made. Called by `clearFetch()`, so a test can
 * declare its expectations and still fail loudly when the SDK stops calling an endpoint.
 */
export function lastMissingRequests(spy: FetchSpy): StubViolation[] {
  const plan = strictPlans.get(spy);
  if (plan === undefined) return [];
  const missing = plan.expected
    .filter((e) => e.remaining !== 'any' && e.remaining > 0)
    .map((e) => ({
      kind: 'extra' as ViolationKind,
      testName: currentTestName(),
      url: describeExpectation(e.spec),
      method: '',
      reasons: [`declared request was never made (${e.remaining} of its calls missing)`],
    }));
  return missing;
}

/** Remove the global fetch stub, failing the current test if it recorded any violation. */
export function clearFetch() {
  const reported: StubViolation[] = [];
  for (const spy of spies) {
    const missing = lastMissingRequests(spy);
    if (missing.length > 0 || spy.violations.length > 0) {
      reported.push(...spy.violations.splice(0, spy.violations.length), ...missing);
    }
  }
  spies.length = 0;
  vi.unstubAllGlobals();
  if (reported.length > 0) {
    throw new Error(
      `Malformed or undeclared stubbed request in test "${reported[0].testName}" ` +
        `(${reported.length} violation${reported.length === 1 ? '' : 's'}):\n${formatViolations(reported)}`,
    );
  }
}

/** A default 200 `{}` stub that records calls without inspecting them. */
export function stubFetchAny(options: StubFetchOptions = {}): FetchSpy {
  return stubFetch(() => json({}), options);
}
