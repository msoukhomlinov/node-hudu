/**
 * Small shared helpers.
 */

/** Narrow unknown to a record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow unknown to a thenable: a strategy's `headers()` may resolve asynchronously (issue #23). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}
