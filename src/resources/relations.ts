/**
 * RelationsResource — Hudu "relations" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError, NotFoundError, ResolutionError } from '../errors.js';
import type {
  DryRunResult,
  HelperOptions,
  Identifier,
  IdentifierObject,
  MutationOptions,
  Resolution,
  ResolutionOptions,
} from '../types/common.js';
import type { Relation, RelationCreate, RelationEndpoint, RelationSummary } from '../types/relation.js';

/**
 * Refuse `expectedUpdatedAt` on a path whose `staleCheck` is "unavailable" (create/delete) instead of
 * silently pretending a guard ran: relations have no update path, so no guard exists for this resource.
 */
function refuseExpectedUpdatedAt(method: string, opts: MutationOptions | undefined): void {
  if (opts?.expectedUpdatedAt === undefined) return;
  throw new HuduConfigError(
    `${method} takes no expectedUpdatedAt: this path records staleCheck "unavailable" (a create has no ` +
      'prior revision to be stale against, and a delete is bounded by its explicit id), and /relations ' +
      'has no update path that could read one. Resolve the relation and re-issue the call instead.',
  );
}


export interface RelationsListParams extends ListParams {
  fromable_type?: string;
  fromable_id?: number;
  toable_type?: string;
  toable_id?: number;
  is_inverse?: boolean;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

/** Options for the bounded relation helpers (policy §9). */
export interface RelationFindOptions {
  /** Maximum rows returned; default 25, hard maximum 100. */
  limit?: number;
  /** Return the full records instead of the compact summaries. */
  expand?: boolean;
  /** Pass the vendor `is_inverse` filter through; omitted means "both directions". */
  isInverse?: boolean;
}

/** Identifier kinds `relations.resolve` accepts: the vendor exposes no `GET /relations/{id}`. */
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
 * Human-readable form of a rejected identifier, for the validation message. Never throws:
 * `JSON.stringify` rejects circular input, and a validation message must not.
 */
function describeIdentifier(identifier: Identifier): string {
  if (typeof identifier === 'string') return JSON.stringify(identifier);
  if (typeof identifier === 'number' || typeof identifier === 'boolean' || typeof identifier === 'bigint') {
    return String(identifier);
  }
  if (identifier === null || identifier === undefined) return String(identifier);
  if (typeof identifier === 'object') {
    const keys = Object.keys(identifier as Record<string, unknown>);
    return keys.length === 0 ? 'an object' : `an object with keys [${keys.join(', ')}]`;
  }
  return typeof identifier;
}

/** Read the numeric id out of an identifier, or fail naming the accepted kinds (never guesses). */
function relationId(identifier: Identifier): number {
  if (typeof identifier === 'number') {
    if (Number.isInteger(identifier) && identifier > 0) return identifier;
  } else if (typeof identifier === 'string') {
    if (/^\d+$/.test(identifier)) return Number(identifier);
  } else if (typeof identifier === 'object' && identifier !== null) {
    const id = (identifier as IdentifierObject).id;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  }
  throw new HuduConfigError(
    `relations.resolve accepts only ${ACCEPTED_KINDS}; got ${describeIdentifier(identifier)}. ` +
      'The Hudu API exposes no GET /relations/{id} and relations have no name filter, so an id ' +
      'is resolved by a bounded client scan of /relations; use relations.findByEndpoints when the ' +
      'endpoints are known.',
  );
}

/** Reject a malformed endpoint reference before it reaches the vendor filter. */
function requireEndpoint(endpoint: RelationEndpoint, position: 'from' | 'to'): void {
  const ok =
    typeof endpoint === 'object' &&
    endpoint !== null &&
    typeof endpoint.type === 'string' &&
    endpoint.type.length > 0 &&
    Number.isInteger(endpoint.id) &&
    endpoint.id > 0;
  if (!ok) {
    throw new HuduConfigError(
      `relations.findByEndpoints requires ${position} to be { type: string, id: number } with a ` +
        `non-empty vendor type and a positive integer id, got ${describeIdentifier(endpoint as unknown as Identifier)}.`,
    );
  }
}

/** Disambiguation label for one relation. */
function relationLabel(relation: Relation): string {
  return `${relation.name} (#${relation.id}: ${relation.fromable_type} ${relation.fromable_id} -> ${relation.toable_type} ${relation.toable_id})`;
}

/** Compact projection (policy §9): drops created_at and updated_at. */
export function toRelationSummary(relation: Relation): RelationSummary {
  return {
    id: relation.id,
    name: relation.name,
    description: relation.description,
    is_inverse: relation.is_inverse,
    fromable_id: relation.fromable_id,
    fromable_type: relation.fromable_type,
    fromable_url: relation.fromable_url,
    toable_id: relation.toable_id,
    toable_type: relation.toable_type,
    toable_url: relation.toable_url,
  };
}

export class RelationsResource extends BaseResource<Relation> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'relations', singleKey: 'relation', listKey: 'relations', createType: 'wrapped', paginated: true });
  }

  /** Stream relations across pages. */
  list(params?: RelationsListParams): AsyncIterable<Relation> {
    return this.items(params ?? {});
  }
  /** Get every relations. MCP-preferred read. */
  async listAll(params?: RelationsListParams): Promise<Relation[]> {
    return this.all(params ?? {});
  }

  /** Create a relations record. */
  async create(data: RelationCreate): Promise<Relation>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: RelationCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Relation>>;
  async create(data: RelationCreate, opts: MutationOptions & { dryRun?: false }): Promise<Relation>;
  async create(data: RelationCreate, opts: MutationOptions | undefined): Promise<Relation | DryRunResult<Relation>>;
  async create(data: RelationCreate, opts?: MutationOptions): Promise<Relation | DryRunResult<Relation>> {
    refuseExpectedUpdatedAt('relations.create', opts);
    return this.createOne<Relation>({ relation: data }, undefined, opts);
  }

  /** Delete a relations record. */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    refuseExpectedUpdatedAt('relations.delete', opts);
    return this.deleteOne(id, opts);
  }

  listPages(params?: RelationsListParams): AsyncIterable<Page<Relation>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve a relation by id.
   *
   * `GET /relations/{id}` does not exist in the Hudu API, so the id is matched by an **explicit,
   * bounded client scan** of `/relations` (500 records / 4 pages by default, from the client's
   * `resolution` config). The accepted kind is **a numeric id only**; anything else throws a
   * structured validation error naming the accepted kind, because the vendor exposes no searchable
   * field that identifies one relation.
   *
   * - a complete scan with no match throws `NOT_FOUND` (an id is a definite reference)
   * - a scan stopped by its cap throws `RESOLUTION_TRUNCATED` — never `null`
   * - `{ allowClientScan: false }` refuses the scan and throws `RESOLUTION_TRUNCATED`, because for
   *   this resource the scan is the only lookup path
   *
   * Default return is {@link RelationSummary}; `{ expand: true }` returns the full record,
   * `{ resolutionDetails: true }` returns a `Resolution<RelationSummary>`.
   */
  async resolve(identifier: Identifier): Promise<RelationSummary | null>;
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<Relation | null>;
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<RelationSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: HelperOptions | ResolutionOptions,
  ): Promise<Relation | RelationSummary | Resolution<RelationSummary> | null>;
  async resolve(
    identifier: Identifier,
    opts?: HelperOptions | ResolutionOptions,
  ): Promise<Relation | RelationSummary | Resolution<RelationSummary> | null> {
    const id = relationId(identifier);
    const allowClientScan = opts !== undefined && 'allowClientScan' in opts ? opts.allowClientScan : undefined;
    if (allowClientScan === false) {
      throw ResolutionError.truncated(
        `relations.resolve: ${this.resourcePath} has no GET /{id} endpoint, so a client scan is the ` +
          'only lookup path and { allowClientScan: false } refuses it.',
        {
          operation: 'relations.resolve',
          resourceIds: [id],
          suggestedAction: 'Allow the bounded client scan, or resolve the relation through relations.findByEndpoints.',
        },
      );
    }
    const resolution = await this.boundedScan<Relation>(this.pageFetcher({}), {
      match: (relation) => relation.id === id,
      label: relationLabel,
      idOf: (relation) => relation.id,
      resolutionCost: 'client-scan',
    });
    if (opts?.resolutionDetails === true) {
      return {
        value:
          resolution.value === null
            ? null
            : opts.expand === true
              ? resolution.value
              : toRelationSummary(resolution.value),
        resolutionCost: resolution.resolutionCost,
        scanned: resolution.scanned,
        scanTruncated: resolution.scanTruncated,
        ...(resolution.candidates === undefined ? {} : { candidates: resolution.candidates }),
      };
    }
    const record = BaseResource.requireResolved(resolution, {
      resource: this.resourcePath,
      operation: 'relations.resolve',
      identifier,
    });
    if (record === null) {
      throw new NotFoundError(
        `relations.resolve: no relation with id ${id} in the ${resolution.scanned} record(s) of a complete /relations scan`,
        undefined,
        undefined,
        {
          operation: 'relations.resolve',
          resourceIds: [id],
          suggestedAction: 'Verify the id, or ask the vendor-side question with relations.findByEndpoints.',
        },
      );
    }
    return opts?.expand === true ? record : toRelationSummary(record);
  }

  /**
   * List the relations that connect two records, in the direction given.
   *
   * The vendor-side `fromable_type`/`fromable_id` and `toable_type`/`toable_id` filters do the
   * matching, so nothing is scanned: exactly one page of at most `limit` rows (default 25, hard
   * maximum 100) is requested, and the vendor decides direction. `{ isInverse }` passes the
   * vendor `is_inverse` filter through; omitted, both the relation and its inverse are returned
   * when the vendor reports them. Two records may legitimately be connected more than once, so
   * this helper returns every matching relation rather than a single one.
   */
  async findByEndpoints(
    from: RelationEndpoint,
    to: RelationEndpoint,
    opts?: RelationFindOptions & { expand?: false },
  ): Promise<RelationSummary[]>;
  async findByEndpoints(
    from: RelationEndpoint,
    to: RelationEndpoint,
    opts: RelationFindOptions & { expand: true },
  ): Promise<Relation[]>;
  async findByEndpoints(
    from: RelationEndpoint,
    to: RelationEndpoint,
    opts?: RelationFindOptions,
  ): Promise<Relation[] | RelationSummary[]>;
  async findByEndpoints(
    from: RelationEndpoint,
    to: RelationEndpoint,
    opts?: RelationFindOptions,
  ): Promise<Relation[] | RelationSummary[]> {
    const limit = helperLimit(opts?.limit, 'relations.findByEndpoints');
    requireEndpoint(from, 'from');
    requireEndpoint(to, 'to');
    const query: Record<string, unknown> = {
      fromable_type: from.type,
      fromable_id: from.id,
      toable_type: to.type,
      toable_id: to.id,
    };
    if (opts?.isInverse !== undefined) query.is_inverse = opts.isInverse;
    const page = await this.pageFetcher(query)(1, limit);
    const items = page.items.slice(0, limit);
    return opts?.expand === true ? items : items.map(toRelationSummary);
  }
}
