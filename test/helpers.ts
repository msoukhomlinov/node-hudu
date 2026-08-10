/**
 * Shared test helpers: mocked global fetch + JSON response builders.
 * Never touches the network.
 */
import { vi } from 'vitest';

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

export interface FetchSpy {
  calls: SpyCall[];
  handler: FetchHandler;
  setHandler(next: FetchHandler): void;
}

/**
 * Install a fetch stub that delegates to `handler` every call.
 * The handler can be swapped later via `setHandler` (used for retry sequences).
 */
export function stubFetch(handler: FetchHandler): FetchSpy {
  const state: FetchSpy = {
    calls: [],
    handler,
    setHandler(next: FetchHandler) {
      this.handler = next;
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit) => {
      const call: SpyCall = { url: String(url), init };
      state.calls.push(call);
      return state.handler(call.url, call.init);
    }),
  );
  return state;
}

/** Remove the global fetch stub. */
export function clearFetch() {
  vi.unstubAllGlobals();
}

/** A default 200 `{}` stub that records calls without inspecting them. */
export function stubFetchAny(): FetchSpy {
  return stubFetch(() => json({}));
}
