/**
 * Small shared helpers.
 */

/** Narrow unknown to a record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
