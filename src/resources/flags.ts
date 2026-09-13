/**
 * FlagsResource — Hudu "flags" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError, NotFoundError } from '../errors.js';
import type {
  DryRunResult,
  HelperOptions,
  Identifier,
  IdentifierObject,
  MutationOptions,
  Resolution,
  ResolutionOptions,
} from '../types/common.js';
import type { Flag, FlagCreate, FlagSummary, FlagUpdate } from '../types/flag.js';

/**
 * Refuse `expectedUpdatedAt` on a path whose `staleCheck` is "unavailable" (create/delete) instead of
 * silently pretending a guard ran. The guard lives only on `update`, where `BaseResource.updateOne`
 * reads the current record and throws `STALE_OBJECT` on a mismatch.
 */
function refuseExpectedUpdatedAt(method: string, opts: MutationOptions | undefined): void {
  if (opts?.expectedUpdatedAt === undefined) return;
  throw new HuduConfigError(
    `${method} takes no expectedUpdatedAt: this path records staleCheck "unavailable" (a create has no ` +
      'prior revision to be stale against, and a delete is bounded by its explicit id). Use it on ' +
      `${method.split('.')[0]}.update, which reads the record and throws STALE_OBJECT on a mismatch.`,
  );
}


export interface FlagsListParams extends ListParams {
  flag_type_id?: number;
  flagable_type?: string;
  flagable_id?: number;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

/** Options for `flags.findByFlagable` (policy §9). */
export interface FlagFindOptions {
  /** Maximum rows returned; default 25, hard maximum 100. */
  limit?: number;
  /** Return the full records instead of the compact summaries. */
  expand?: boolean;
}

/** Identifier kinds `flags.resolve` accepts: a flag has no name field. */
const ACCEPTED_KINDS = 'a numeric id (a number, a numeric string, or { id: number })';

/** Helper-tier row bound (policy §9): documented default and a hard maximum. */
const DEFAULT_HELPER_LIMIT = 25;
const MAX_HELPER_LIMIT = 100;

/** Read `limit`, or fail deterministically above the hard maximum (never silently clamp). */
function helperLimit(limit: number | undefined, context: string): number {
  if (limit === undefined) return DEFAULT_HELPER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HELPER_LIMIT) {
    throw new HuduConfigError(`${context} limit must be an integer from 1 to ${MAX_HELPER_LIMIT}, got ${String(limit)}`);
  }
  return limit;
}

/**
 * Human-readable form of a rejected value, for the validation message. Never throws:
 * `JSON.stringify` rejects circular input, and a validation message must not.
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 0 ? 'an object' : `an object with keys [${keys.join(', ')}]`;
  }
  return typeof value;
}

/** Read the numeric id out of an identifier, or fail naming the accepted kinds (never guesses). */
function flagId(identifier: Identifier): number {
  if (typeof identifier === 'number') {
    if (Number.isInteger(identifier) && identifier > 0) return identifier;
  } else if (typeof identifier === 'string') {
    if (/^\d+$/.test(identifier)) return Number(identifier);
  } else if (typeof identifier === 'object' && identifier !== null) {
    const id = (identifier as IdentifierObject).id;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  }
  throw new HuduConfigError(
    `flags.resolve accepts only ${ACCEPTED_KINDS}; got ${describeValue(identifier)}. ` +
      'A flag carries its text in `description` and has no name, and the vendor exposes no filter ' +
      'that identifies one flag: use flags.findByFlagable to list the flags on a record.',
  );
}

/** Reject a malformed flagable reference before it reaches the vendor filter. */
function requireFlagable(flagableType: string, flagableId: number): void {
  if (typeof flagableType !== 'string' || flagableType.length === 0 || !Number.isInteger(flagableId) || flagableId < 1) {
    throw new HuduConfigError(
      'flags.findByFlagable requires a non-empty flagable_type string and a positive integer ' +
        `flagable_id, got ${describeValue(flagableType)} / ${describeValue(flagableId)}.`,
    );
  }
}

/** Compact projection (policy §9): drops created_at only. */
function toFlagSummary(flag: Flag): FlagSummary {
  return {
    id: flag.id,
    flag_type_id: flag.flag_type_id,
    description: flag.description,
    flagable_type: flag.flagable_type,
    flagable_id: flag.flagable_id,
    updated_at: flag.updated_at,
  };
}

export class FlagsResource extends BaseResource<Flag> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'flags', singleKey: 'flag', listKey: 'flags', createType: 'wrapped', paginated: true });
  }

  /** Get a flags by id. */
  async get(id: number): Promise<Flag> {
    return this.getOne<Flag>(id);
  }
  /** Stream flags across pages. */
  list(params?: FlagsListParams): AsyncIterable<Flag> {
    return this.items(params ?? {});
  }
  /** Get every flags. MCP-preferred read. */
  async listAll(params?: FlagsListParams): Promise<Flag[]> {
    return this.all(params ?? {});
  }

  /**
   * Create a flags record. `staleCheck` is `"unavailable"` for a create: a new record has no prior
   * revision to be stale against, so the opt-in `expectedUpdatedAt` guard is not part of this path and
   * supplying it is refused with `HuduConfigError` (never silently ignored, never a false STALE_OBJECT).
   */
  async create(data: FlagCreate): Promise<Flag>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: FlagCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Flag>>;
  async create(data: FlagCreate, opts: MutationOptions & { dryRun?: false }): Promise<Flag>;
  async create(data: FlagCreate, opts: MutationOptions | undefined): Promise<Flag | DryRunResult<Flag>>;
  async create(data: FlagCreate, opts?: MutationOptions): Promise<Flag | DryRunResult<Flag>> {
    refuseExpectedUpdatedAt('flags.create', opts);
    return this.createOne<Flag>({ flag: data }, undefined, opts);
  }

  /** Update a flags record (PUT response unwrapped by singleKey; opt-in `expectedUpdatedAt` guard). */
  async update(id: number, data: FlagUpdate): Promise<Flag>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: FlagUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Flag>>;
  async update(id: number, data: FlagUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Flag>;
  async update(id: number, data: FlagUpdate, opts: MutationOptions | undefined): Promise<Flag | DryRunResult<Flag>>;
  async update(id: number, data: FlagUpdate, opts?: MutationOptions): Promise<Flag | DryRunResult<Flag>> {
    return this.updateOne<Flag>(id, { flag: data }, undefined, opts);
  }

  /**
   * Delete a flags record. `staleCheck` is `"unavailable"` here: the delete is bounded by the explicit
   * id and Hudu exposes no conditional delete, so no `expectedUpdatedAt` read is made and supplying the
   * option is refused with `HuduConfigError`.
   */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    refuseExpectedUpdatedAt('flags.delete', opts);
    return this.deleteOne(id, opts);
  }

  listPages(params?: FlagsListParams): AsyncIterable<Page<Flag>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve a flag from an identifier.
   *
   * Accepted kind: **a numeric id only** (policy §6). A flag has no name field (its text lives in
   * `description`) and the vendor exposes no filter that identifies one flag, so an id is fetched
   * directly with `GET /flags/{id}` and any other kind throws a structured validation error naming
   * the accepted kind — the helper never guesses and never scans. An id miss throws `NOT_FOUND`
   * (never `null`).
   *
   * Default return is {@link FlagSummary}; `{ expand: true }` returns the full record,
   * `{ resolutionDetails: true }` returns a `Resolution<FlagSummary>`.
   */
  async resolve(identifier: Identifier): Promise<FlagSummary | null>;
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<Flag | null>;
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<FlagSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: HelperOptions | ResolutionOptions,
  ): Promise<Flag | FlagSummary | Resolution<FlagSummary> | null>;
  async resolve(
    identifier: Identifier,
    opts?: HelperOptions | ResolutionOptions,
  ): Promise<Flag | FlagSummary | Resolution<FlagSummary> | null> {
    const id = flagId(identifier);
    let record: Flag;
    try {
      record = await this.getOne<Flag>(id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`flags.resolve: no flag with id ${id}`, err.url, err.body, {
          operation: 'flags.resolve',
          resourceIds: [id],
          correlationId: err.correlationId,
        });
      }
      throw err;
    }
    if (opts?.resolutionDetails === true) {
      return { value: toFlagSummary(record), resolutionCost: 'direct', scanned: 1, scanTruncated: false };
    }
    return opts?.expand === true ? record : toFlagSummary(record);
  }

  /**
   * List the flags attached to one record, using the vendor `flagable_type` + `flagable_id`
   * filters. No scan runs: exactly one page of at most `limit` rows (default 25, hard maximum 100)
   * is requested. A record may carry several flags, so every match is returned.
   */
  async findByFlagable(
    flagableType: string,
    flagableId: number,
    opts?: FlagFindOptions & { expand?: false },
  ): Promise<FlagSummary[]>;
  async findByFlagable(
    flagableType: string,
    flagableId: number,
    opts: FlagFindOptions & { expand: true },
  ): Promise<Flag[]>;
  async findByFlagable(
    flagableType: string,
    flagableId: number,
    opts?: FlagFindOptions,
  ): Promise<Flag[] | FlagSummary[]>;
  async findByFlagable(
    flagableType: string,
    flagableId: number,
    opts?: FlagFindOptions,
  ): Promise<Flag[] | FlagSummary[]> {
    const limit = helperLimit(opts?.limit, 'flags.findByFlagable');
    requireFlagable(flagableType, flagableId);
    const page = await this.pageFetcher({ flagable_type: flagableType, flagable_id: flagableId })(1, limit);
    const items = page.items.slice(0, limit);
    return opts?.expand === true ? items : items.map(toFlagSummary);
  }
}
