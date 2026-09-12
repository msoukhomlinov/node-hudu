/**
 * Shared helper-tier plumbing for the agent-execution-layer helper floor
 * (policy §5/§6/§9).
 *
 * Pure functions and result builders only. The bounded scan itself stays in
 * `BaseResource.boundedScan` (which every helper calls), the request stays in
 * `BaseResource`/`HttpClient`, and this module owns no transport, no state and no
 * per-resource knowledge — it exists so the group C resources do not each
 * re-implement the same limit/policy/ambiguity decisions.
 */
import { HuduConfigError, NotFoundError, ResolutionError } from '../errors.js';
import type { Identifier, Resolution, ResolutionCandidate, ResolutionCost } from '../types/common.js';

/** Default `limit` of a helper that returns or examines a bounded list (policy §9). */
export const DEFAULT_HELPER_LIMIT = 25;

/** Hard maximum `limit`; above it a helper throws instead of silently clamping (policy §9). */
export const MAX_HELPER_LIMIT = 100;

/**
 * Bound a helper `limit`: default 25, hard maximum 100. Never clamps silently —
 * an out-of-range limit is a caller bug, and clamping would hide it.
 */
export function helperLimit(limit: number | undefined, method: string): number {
  const value = limit ?? DEFAULT_HELPER_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HELPER_LIMIT) {
    throw new HuduConfigError(
      `${method}: limit must be an integer from 1 to ${MAX_HELPER_LIMIT}, got "${String(limit)}"`,
    );
  }
  return value;
}

/**
 * Structured refusal of an identifier kind the vendor cannot filter on, naming the
 * kinds that ARE accepted (policy §6). Guessing an identifier kind is how an SDK
 * silently resolves the wrong record, so it is rejected instead.
 */
export function identifierError(method: string, accepted: string): HuduConfigError {
  return new HuduConfigError(
    `${method} accepts ${accepted}; the SDK does not guess an identifier kind the vendor cannot filter on.`,
  );
}

/** A positive integer id, or a structured validation error naming what is required. */
export function requirePositiveId(id: number | undefined, method: string): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
    throw new HuduConfigError(`${method} requires a positive integer id, got "${String(id)}"`);
  }
  return id;
}

/** What one bounded exact-match collection produced. */
export interface CollectedMatches<T> {
  matches: T[];
  /** Records the scan actually examined. */
  scanned: number;
  /** True when a scan cap stopped the search before the data ran out. */
  truncated: boolean;
  resolutionCost: ResolutionCost;
}

export interface DecideResolutionOptions<T> {
  /** Registry-style operation name, e.g. 'procedures.resolve'. */
  operation: string;
  /** Resource path used in error messages, e.g. 'procedures'. */
  resource: string;
  /** The identifier the caller passed; its numeric id (when any) reaches the error. */
  identifier?: Identifier;
  matches: T[];
  scanned: number;
  truncated: boolean;
  resolutionCost: ResolutionCost;
  label: (item: T) => string;
  idOf: (item: T) => number;
  /**
   * True when the identifier names exactly one record (an id). A complete scan
   * that finds nothing then throws NOT_FOUND instead of returning `null`, because
   * `null` means "no record has this name/slug", never "your id does not exist".
   */
  definite?: boolean;
}

/**
 * Turn one bounded collection into a `Resolution<T>` (policy §6).
 *
 * - a cap that stopped the scan throws RESOLUTION_TRUNCATED — never `null`, which
 *   would read as "does not exist";
 * - several matches throw RESOLUTION_AMBIGUOUS with the candidate ids in `resourceIds`;
 * - a complete scan with one match resolves it (with that match as the candidate);
 * - a complete scan with no match returns `null`, or throws NOT_FOUND when the
 *   identifier was definite.
 */
export function decideResolution<T>(opts: DecideResolutionOptions<T>): Resolution<T> {
  const ids = opts.matches.map(opts.idOf);
  if (opts.truncated) {
    throw ResolutionError.truncated(
      `${opts.operation}: the bounded scan stopped after ${opts.scanned} record(s) before the data ran out, ` +
        'so the record cannot be decided.',
      {
        operation: opts.operation,
        resourceIds: ids.length > 0 ? ids : undefined,
        suggestedAction: 'Pass { id }, narrow with a vendor filter, or raise resolution.maxScanRecords/maxScanPages.',
      },
    );
  }
  if (opts.matches.length > 1) {
    const preview = ids.slice(0, 10).join(', ');
    throw ResolutionError.ambiguous(
      `${opts.operation}: ${opts.matches.length} records match the identifier and the vendor filter cannot ` +
        `disambiguate them${preview.length > 0 ? ` (ids ${preview}${ids.length > 10 ? ', ...' : ''})` : ''}.`,
      {
        operation: opts.operation,
        resourceIds: ids,
        suggestedAction: 'Pass the numeric id of the record you want.',
      },
    );
  }
  const only = opts.matches[0];
  if (only === undefined) {
    if (opts.definite === true) {
      throw new NotFoundError(
        `${opts.operation}: no ${opts.resource} record matches the requested id`,
        undefined,
        undefined,
        { operation: opts.operation, resourceIds: numericIds(opts.identifier) },
      );
    }
    return { value: null, resolutionCost: opts.resolutionCost, scanned: opts.scanned, scanTruncated: false };
  }
  const candidates: ResolutionCandidate[] = [{ id: opts.idOf(only), label: opts.label(only) }];
  return {
    value: only,
    resolutionCost: opts.resolutionCost,
    scanned: opts.scanned,
    scanTruncated: false,
    candidates,
  };
}

/** Numeric ids carried by an identifier, for structured errors. */
export function numericIds(identifier: Identifier | undefined): number[] | undefined {
  if (identifier === undefined) return undefined;
  if (typeof identifier === 'number') return [identifier];
  if (typeof identifier === 'string') return /^\d+$/.test(identifier) ? [Number(identifier)] : undefined;
  return typeof identifier.id === 'number' ? [identifier.id] : undefined;
}

/** Refuse a fallback client scan when the caller set `allowClientScan: false` (policy §6). */
export function refuseClientScan(operation: string, resource: string, identifier?: Identifier): never {
  throw ResolutionError.truncated(
    `${operation}: a client scan is required to resolve this identifier but allowClientScan is false.`,
    {
      operation,
      resourceIds: numericIds(identifier),
      suggestedAction: `Resolve by { id } or a vendor filter, or call with allowClientScan: true for a bounded scan of ${resource}.`,
    },
  );
}
