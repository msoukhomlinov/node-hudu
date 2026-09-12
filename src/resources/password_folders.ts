/**
 * PasswordFoldersResource — Hudu "password_folders" resource.
 *
 * Sensitive by classification: the compact summary never carries `allowed_groups`,
 * and the audit payloads for every operation are redacted (`redaction: credentials`).
 * Returned data is never redacted implicitly — call `redact()` when the caller wants it.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type {
  PasswordFolder,
  PasswordFolderCreate,
  PasswordFolderIdentifier,
  PasswordFolderSummary,
  PasswordFolderUpdate,
} from '../types/password_folder.js';
import type { DryRunResult, HelperOptions, MutationOptions, Resolution } from '../types/common.js';
import { HuduConfigError, ResolutionError, ValidationFailedError } from '../errors.js';

export interface PasswordFoldersListParams extends ListParams {
  name?: string;
  company_id?: number;
  search?: string;
}

/**
 * Options of `password_folders.search`. A search returns a LIST, so it accepts neither
 * `resolutionDetails` nor a stale guard: `limit`, `expand` and the vendor `company_id`
 * scope only, and each is honoured.
 */
export interface PasswordFolderSearchOptions {
  /** Maximum rows returned; default 25, hard maximum 100. */
  limit?: number;
  /** Return the full records instead of the compact summaries. */
  expand?: boolean;
  /** Narrow the vendor `search` with the vendor `company_id` filter. */
  company_id?: number;
}

/** Rows a list-shaped helper returns when the caller does not say. */
const DEFAULT_LIMIT = 25;
/** Hard maximum rows a helper returns; above it the SDK refuses instead of clamping. */
const MAX_LIMIT = 100;

/** Validate a helper `limit` (default 25, hard max 100, never silently clamped). */
function helperLimit(limit: number | undefined, helper: string): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new HuduConfigError(
      `${helper}: limit must be an integer from 1 to ${MAX_LIMIT}, got "${String(limit)}"`,
    );
  }
  return limit;
}

/** One bounded, vendor-filtered scan for exact matches. */
interface ExactScan<T> {
  matches: T[];
  scanned: number;
  scanTruncated: boolean;
}

/**
 * The compact projection of a password folder (`PasswordFolderSummary`). `allowed_groups`
 * is dropped: group ids are an access-control list, not agent-facing data.
 */
function toPasswordFolderSummary(record: PasswordFolder): PasswordFolderSummary {
  return {
    id: record.id,
    name: record.name,
    company_id: record.company_id,
    slug: record.slug,
    security: record.security,
    updated_at: record.updated_at,
  };
}

/** The identifier kinds `password_folders.resolve` accepts (documented in the registry `usage`). */
const ACCEPTED_KINDS = 'a bare id/name or an object with one of { id } or { name }, optionally narrowed by company_id';

/** A normalized lookup for `resolve`. */
type PasswordFolderLookup =
  | { kind: 'id'; id: number }
  | { kind: 'name'; name: string; company_id?: number | null }
  | { kind: 'bare'; value: string };

/** Normalize the accepted identifier forms, refusing anything the vendor cannot support. */
function passwordFolderLookup(identifier: number | string | PasswordFolderIdentifier): PasswordFolderLookup {
  if (typeof identifier === 'number') {
    if (!Number.isInteger(identifier) || identifier < 1) {
      throw new ValidationFailedError(
        `password_folders.resolve: expected a positive integer id, got "${String(identifier)}"; accepted: ${ACCEPTED_KINDS}`,
      );
    }
    return { kind: 'id', id: identifier };
  }
  if (typeof identifier === 'string') {
    const text = identifier.trim();
    if (text.length === 0) {
      throw new ValidationFailedError(
        `password_folders.resolve: expected a non-empty identifier; accepted: ${ACCEPTED_KINDS}`,
      );
    }
    return /^\d+$/.test(text) ? { kind: 'id', id: Number(text) } : { kind: 'bare', value: text };
  }
  const raw = identifier as Record<string, unknown>;
  const has = (key: string): boolean => raw[key] !== undefined && raw[key] !== null;
  if (has('id') && has('name')) {
    throw new ValidationFailedError('password_folders.resolve: pass { id } or { name }, not both');
  }
  const companyId = has('company_id') ? raw.company_id : has('companyId') ? raw.companyId : undefined;
  if (has('id')) {
    const id = raw.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      throw new ValidationFailedError(
        `password_folders.resolve: { id } must be a positive integer, got "${String(id)}"`,
      );
    }
    return { kind: 'id', id };
  }
  if (has('name')) {
    const name = raw.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationFailedError(
        `password_folders.resolve: { name } must be a non-empty string, got "${String(name)}"`,
      );
    }
    return { kind: 'name', name, company_id: companyId as number | undefined };
  }
  throw new ValidationFailedError(
    `password_folders.resolve: unsupported identifier ${JSON.stringify(Object.keys(raw))}; accepted: ${ACCEPTED_KINDS}. ` +
      'The vendor filters /password_folders by name only, so a slug is not a supported kind here.',
  );
}

/** Format a resolution for the helper tier: compact by default, full record on `expand`. */
function formatResolution<T, S>(
  resolution: Resolution<T>,
  toSummary: (record: T) => S,
  opts: HelperOptions | undefined,
): S | T | null | Resolution<S> | Resolution<T> {
  const record = resolution.value;
  if (opts?.resolutionDetails) {
    if (opts.expand) return resolution;
    return { ...resolution, value: record === null ? null : toSummary(record) };
  }
  if (record === null) return null;
  return opts?.expand ? record : toSummary(record);
}

export class PasswordFoldersResource extends BaseResource<PasswordFolder> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'password_folders', singleKey: 'password_folder', listKey: 'password_folders', createType: 'wrapped', paginated: true });
  }

  /** Get a password_folders by id. */
  async get(id: number): Promise<PasswordFolder> {
    return this.getOne<PasswordFolder>(id);
  }
  /** Stream password_folders across pages. */
  list(params?: PasswordFoldersListParams): AsyncIterable<PasswordFolder> {
    return this.items(params ?? {});
  }
  /** Get every password_folders. MCP-preferred read. */
  async listAll(params?: PasswordFoldersListParams): Promise<PasswordFolder[]> {
    return this.all(params ?? {});
  }
  /** Create a password folder. `{ dryRun: true }` describes the write without issuing it. */
  async create(data: PasswordFolderCreate): Promise<PasswordFolder>;
  async create(data: PasswordFolderCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<PasswordFolder>>;
  async create(data: PasswordFolderCreate, opts: MutationOptions & { dryRun?: false }): Promise<PasswordFolder>;
  async create(data: PasswordFolderCreate, opts: MutationOptions | undefined): Promise<PasswordFolder | DryRunResult<PasswordFolder>>;
  async create(data: PasswordFolderCreate, opts?: MutationOptions): Promise<PasswordFolder | DryRunResult<PasswordFolder>> {
    this.refuseGuardOnCreateOrDelete('password_folders.create', opts);
    if (opts?.dryRun) return this.createOne<PasswordFolder>(data, undefined, { dryRun: true });
    return this.createOne<PasswordFolder>(data);
  }

  /** Update a password folder. `{ dryRun: true }` describes the write; `{ expectedUpdatedAt }` guards it. */
  async update(id: number, data: PasswordFolderUpdate): Promise<PasswordFolder>;
  async update(id: number, data: PasswordFolderUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<PasswordFolder>>;
  async update(id: number, data: PasswordFolderUpdate, opts: MutationOptions & { dryRun?: false }): Promise<PasswordFolder>;
  async update(id: number, data: PasswordFolderUpdate, opts: MutationOptions | undefined): Promise<PasswordFolder | DryRunResult<PasswordFolder>>;
  async update(id: number, data: PasswordFolderUpdate, opts?: MutationOptions): Promise<PasswordFolder | DryRunResult<PasswordFolder>> {
    if (opts?.dryRun) return this.updateOne<PasswordFolder>(id, data, undefined, { dryRun: true });
    if (opts?.expectedUpdatedAt !== undefined) {
      return this.updateOne<PasswordFolder>(id, data, undefined, { expectedUpdatedAt: opts.expectedUpdatedAt });
    }
    return this.updateOne<PasswordFolder>(id, data);
  }

  /** Delete a password folder. `{ dryRun: true }` describes the delete (plan `staleCheck: unavailable`). */
  async delete(id: number): Promise<void>;
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    this.refuseGuardOnCreateOrDelete('password_folders.delete', opts);
    if (opts?.dryRun) return this.deleteOne(id, { dryRun: true });
    return this.deleteOne(id);
  }

  listPages(params?: PasswordFoldersListParams): AsyncIterable<Page<PasswordFolder>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §6/§9). Sensitive resource: helpers return the compact
  // summary, which never carries the `allowed_groups` access list.
  // ---------------------------------------------------------------------------

  /**
   * Resolve one password folder.
   *
   * Bare values are read in the documented order: numeric id, then exact name. Pass
   * `company_id` in the identifier to disambiguate the account-wide folder of the same
   * name. `{ id }` is a direct fetch and a miss throws NOT_FOUND (never null); null means
   * a COMPLETE scan found nothing; a scan stopped by the client cap throws
   * RESOLUTION_TRUNCATED; several exact matches throw RESOLUTION_AMBIGUOUS.
   */
  async resolve(identifier: number | string | PasswordFolderIdentifier): Promise<PasswordFolderSummary | null>;
  async resolve(identifier: number | string | PasswordFolderIdentifier, opts: { expand: true }): Promise<PasswordFolder | null>;
  async resolve(identifier: number | string | PasswordFolderIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<PasswordFolderSummary>>;
  /** Both flags: the resolution of the FULL records. */
  async resolve(identifier: number | string | PasswordFolderIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<PasswordFolder>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(identifier: number | string | PasswordFolderIdentifier, opts: HelperOptions): Promise<PasswordFolder | PasswordFolderSummary | null | Resolution<PasswordFolderSummary> | Resolution<PasswordFolder>>;
  async resolve(
    identifier: number | string | PasswordFolderIdentifier,
    opts?: HelperOptions,
  ): Promise<PasswordFolder | PasswordFolderSummary | null | Resolution<PasswordFolderSummary> | Resolution<PasswordFolder>> {
    return formatResolution(await this.resolveRecord(identifier), toPasswordFolderSummary, opts);
  }

  /**
   * Search password folders by free text (vendor `search` filter), optionally scoped
   * with `company_id`. `limit` defaults to 25 and never exceeds 100.
   */
  async search(query: string): Promise<PasswordFolderSummary[]>;
  /** `expand: true` returns the full records. */
  async search(query: string, opts: { expand: true; limit?: number; company_id?: number }): Promise<PasswordFolder[]>;
  /** The caller-facing loose form: `limit` bounds the rows, `company_id` narrows, `expand` returns full records. */
  async search(query: string, opts?: PasswordFolderSearchOptions): Promise<PasswordFolderSummary[] | PasswordFolder[]>;
  async search(query: string, opts?: PasswordFolderSearchOptions): Promise<PasswordFolderSummary[] | PasswordFolder[]> {
    const limit = helperLimit(opts?.limit, 'password_folders.search');
    const params: PasswordFoldersListParams = { search: query };
    if (opts?.company_id !== undefined) params.company_id = opts.company_id;
    const page = await this.pageFetcher(params)(1, limit);
    const items = page.items.slice(0, limit);
    return opts?.expand ? items : items.map(toPasswordFolderSummary);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Bounded, vendor-filtered scan that reports every exact match it examined. */
  private async scanExact(
    params: PasswordFoldersListParams,
    isExact: (item: PasswordFolder) => boolean,
  ): Promise<ExactScan<PasswordFolder>> {
    const matches: PasswordFolder[] = [];
    const resolution = await this.boundedScan<PasswordFolder>(this.pageFetcher(params), {
      match: (item) => {
        if (!isExact(item)) return false;
        matches.push(item);
        // Keep reading after the first exact match: a second one makes the lookup
        // ambiguous, and the scan stays bounded either way.
        return matches.length > 1;
      },
      label: (item) => item.name,
      idOf: (item) => item.id,
      resolutionCost: 'server-filter',
    });
    return {
      matches,
      scanned: resolution.scanned,
      scanTruncated: resolution.value === null && resolution.scanTruncated,
    };
  }

  /** Turn one bounded exact scan into a Resolution, or throw the error it implies. */
  private decideScan(
    scan: ExactScan<PasswordFolder>,
    operation: string,
    detail: string,
  ): Resolution<PasswordFolder> {
    const first = scan.matches[0];
    if (scan.matches.length > 1) {
      const ids = scan.matches.map((match) => match.id);
      throw ResolutionError.ambiguous(
        `${operation}: ${String(ids.length)} password folders match ${detail}; pass company_id or an id from resourceIds to disambiguate.`,
        { operation, resourceIds: ids },
      );
    }
    if (first !== undefined) {
      return {
        value: first,
        resolutionCost: 'server-filter',
        scanned: scan.scanned,
        scanTruncated: false,
        candidates: [{ id: first.id, label: first.name }],
      };
    }
    if (scan.scanTruncated) {
      throw ResolutionError.truncated(
        `${operation}: the bounded client scan was truncated after ${String(scan.scanned)} record(s); ` +
          `${detail} may exist beyond the scan cap.`,
        { operation },
      );
    }
    return { value: null, resolutionCost: 'server-filter', scanned: scan.scanned, scanTruncated: false };
  }

  /** Resolve the identifier to a full record (policy §6). */
  private async resolveRecord(identifier: number | string | PasswordFolderIdentifier): Promise<Resolution<PasswordFolder>> {
    const lookup = passwordFolderLookup(identifier);
    if (lookup.kind === 'id') {
      const record = await this.get(lookup.id);
      return { value: record, resolutionCost: 'direct', scanned: 0, scanTruncated: false };
    }
    if (lookup.kind === 'name') {
      return this.lookupByName(lookup.name, lookup.company_id);
    }
    // Bare value: numeric id first (handled above), then the exact name.
    return this.lookupByName(lookup.value, undefined);
  }

  /** One vendor-`name`-filtered lookup (the account-wide folder may repeat across companies). */
  private async lookupByName(
    name: string,
    companyId: number | null | undefined,
  ): Promise<Resolution<PasswordFolder>> {
    const params: PasswordFoldersListParams = { name };
    if (companyId !== undefined && companyId !== null) params.company_id = companyId;
    const scan = await this.scanExact(params, (item) => item.name === name);
    return this.decideScan(scan, 'password_folders.resolve', `name "${name}"`);
  }

  /**
   * The `expectedUpdatedAt` guard reads the CURRENT record and compares its `updated_at`,
   * so it belongs to the update path only (SCOPING decision 5: create and delete carry
   * `staleCheck: unavailable`). Silently ignoring the option would claim a guard that
   * never ran, so it is refused instead.
   */
  private refuseGuardOnCreateOrDelete(operation: string, opts: MutationOptions | undefined): void {
    if (opts?.expectedUpdatedAt !== undefined) {
      throw new HuduConfigError(
        `${operation}: expectedUpdatedAt compares an existing revision, so it applies to update (PUT) only`,
      );
    }
  }
}
