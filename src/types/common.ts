/**
 * Shared agent-execution-layer types.
 *
 * Declared ONCE here so all 35 resource classes share one shape for operation
 * metadata, dry-run results, resolution results and identifiers. Nothing in this
 * module has runtime output; it is types only.
 */

/** Highest-impact effect of an operation (policy §7.1). Never combine properties in one value. */
export type OperationEffect = 'read' | 'write' | 'destructive';

/** Which representation a caller wants a rich-text field in. */
export type ContentFormat = 'html' | 'markdown';

/** Orthogonal flags; "destructive AND sensitive" must stay expressible. */
export type OperationFlag = 'sensitive' | 'idempotent' | 'requiresApproval';

/** Metadata for one registered operation. */
export interface OperationMetadata {
  /** Registry operation name, e.g. 'companies.update'. */
  operation: string;
  effect: OperationEffect;
  /** Orthogonal flags; use an empty array for an unflagged operation. */
  flags: OperationFlag[];
  /** True when the operation accepts `{ dryRun: true }`. */
  dryRun: boolean;
  /** API key scopes/permissions the vendor documents for this operation. */
  permissions?: string[];
  /** Related operation names an agent may need next. */
  related?: string[];
  /** When an agent should prefer this operation over the others. */
  preferredWhen?: string;
  /** Accepted identifier kinds and a one-line usage note. */
  usage?: string;
}

/** One field-level change a dry-run update would make. */
export interface FieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}

/** One validation/verification performed by a dry-run. */
export interface DryRunCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Dry-run result (policy §7.2). `simulated: true` is mandatory: the server's
 * computed result cannot be promised, and `diff`/`impact` are best-effort.
 * The type parameter carries the resource/record type the real call would return.
 */
export interface DryRunResult<T = unknown> {
  operation: string;
  wouldApply: boolean;
  target: { resource: string; ids: number[] };
  request: { method: string; path: string };
  diff?: FieldDiff[];
  checks: DryRunCheck[];
  impact: OperationImpact;
  simulated: true;
  warnings: string[];
  /**
   * Phantom, never set at runtime and never constructed: it pins the record type the
   * real (non-dry-run) call would return, so `DryRunResult<Company>` is not
   * interchangeable with `DryRunResult<Website>`.
   */
  readonly __recordType?: T;
}

/** How a resolution was obtained. */
export type ResolutionCost = 'direct' | 'server-filter' | 'client-scan';

/** One disambiguation candidate. */
export interface ResolutionCandidate {
  id: number;
  label: string;
}

/**
 * Resolution result (policy §6). `scanTruncated` is the same field name the plan
 * and registry use. `value: null` is reserved for "a complete scan found nothing";
 * a capped scan reports `scanTruncated: true` instead.
 */
export interface Resolution<T = unknown> {
  value: T | null;
  resolutionCost: ResolutionCost;
  scanned: number;
  scanTruncated: boolean;
  candidates?: ResolutionCandidate[];
}

/** Audit event handed to the optional `onAudit` hook. Credential fields are redacted. */
export interface AuditEvent {
  /** One id per request, reused across retries. */
  correlationId: string;
  /** Registry-style operation name, e.g. 'companies.create'. */
  operation: string;
  method: string;
  /** Path only — never the query string. */
  path: string;
  effect: OperationEffect;
  dryRun: boolean;
  outcome: 'success' | 'error';
  httpStatus?: number;
  resourceIds?: number[];
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /** Redacted query parameters, when the request had any. */
  query?: Record<string, unknown>;
  /**
   * Impact statement for an executed mutation (policy §7.3): the SDK must not change any
   * primitive's return shape, so the audit event is the executed-result metadata channel.
   * Absent on `effect: 'read'` events.
   */
  impact?: OperationImpact;
}

/**
 * Impact statement shared by the dry-run result and the executed-result metadata
 * (audit event). `exact: false` means `affected` is a LOWER BOUND — the server
 * computes the real target set (e.g. a bulk delete by filter); `exact` absent or
 * `true` means `affected` is the count the SDK knows it will touch.
 */
export interface OperationImpact {
  affected: number;
  scope: 'single' | 'bulk';
  reversible: boolean;
  exact?: boolean;
}

/** Any value a resource accepts as an identifier. */
export type Identifier = number | string | IdentifierObject;

/** Object form of an identifier, for resources that accept more than an id. */
export interface IdentifierObject {
  id?: number;
  name?: string;
  slug?: string;
  external_id?: string;
  domain?: string;
  [key: string]: unknown;
}

/** Options shared by the helper tier (policy §9). */
export interface HelperOptions {
  /** Maximum rows a helper returns; each helper documents its default and maximum. */
  limit?: number;
  /** Return the full record instead of the compact shape. */
  expand?: boolean;
  /** Return a `Resolution<T>` (cost, scanned, scanTruncated, candidates) instead of plain data. */
  resolutionDetails?: boolean;
}

/** Options accepted by `resolve`. */
export interface ResolutionOptions extends HelperOptions {
  /** Set false to refuse a fallback client scan and fail with RESOLUTION_TRUNCATED instead. */
  allowClientScan?: boolean;
}

/** Options accepted by the mutating primitives. */
export interface MutationOptions {
  /** Describe the mutation instead of performing it. */
  dryRun?: boolean;
  /** Opt-in stale-object guard: the `updated_at` the caller last read for this record. */
  expectedUpdatedAt?: string;
}

