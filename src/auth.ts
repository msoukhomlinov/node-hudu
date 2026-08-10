/**
 * Authentication header construction.
 * The Hudu API authenticates via the `x-api-key` header.
 */
export const API_KEY_HEADER = 'x-api-key';
export const BEARER_PREFIX = 'Bearer ';

export function buildAuthHeaders(apiKey: string): Record<string, string> {
  return { [API_KEY_HEADER]: apiKey };
}

export function withAuth(
  headers: Record<string, string> | undefined,
  apiKey: string,
): Record<string, string> {
  return { ...buildAuthHeaders(apiKey), ...(headers ?? {}) };
}
