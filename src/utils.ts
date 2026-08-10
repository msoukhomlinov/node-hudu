/**
 * Small shared helpers.
 */
/** Narrow unknown to a record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge two query objects; later wins. Returns a new object. */
export function mergeQuery(
  base: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  if (!extra) return { ...base };
  return { ...base, ...extra };
}

/** Assert a value is a non-empty trimmed string; otherwise throw. */
export function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

/** Coerce a number-or-string id to a string for URL interpolation. */
export function idToString(id: number | string): string {
  return String(id);
}
