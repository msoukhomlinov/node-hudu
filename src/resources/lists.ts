/**
 * ListsResource — Hudu "lists" resource.
 *
 * Agent-execution-layer tier (policy §5-§9): the `resolve` / `findByName` helpers,
 * dry-run on the mutations and the opt-in `expectedUpdatedAt` stale guard.
 *
 * GET /lists is NON-paginated: page/page_size are never sent, so a name lookup reads
 * the whole collection in ONE bounded fetch and cannot be truncated by a page cap.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError, ResolutionError } from '../errors.js';
import type { DryRunResult, HelperOptions, MutationOptions, Resolution } from '../types/common.js';
import type { List, ListCreate, ListUpdate } from '../types/index.js';
import type { ListIdentifier } from '../types/list.js';

export interface ListsListParams extends ListParams {
  query?: string;
  name?: string;
}

/** Read the id/name a caller supplied, without guessing a kind the vendor cannot support. */
function readListIdentifier(identifier: number | string | ListIdentifier): { id?: number; name?: string } {
  if (typeof identifier === 'number') return { id: identifier };
  if (typeof identifier === 'string') {
    return /^\d+$/.test(identifier.trim()) ? { id: Number(identifier.trim()) } : { name: identifier };
  }
  return { id: identifier.id, name: identifier.name };
}

/**
 * The opt-in stale guard is `unavailable` for every operation except update (plan
 * decision: a create has no prior revision to be stale against, and a delete is already
 * bounded by its explicit id — Hudu exposes no conditional delete). Passing
 * `expectedUpdatedAt` there is a structural caller error, so it is refused with
 * CONFIG_ERROR rather than silently ignored.
 */
function refuseExpectedUpdatedAt(
  resourcePath: string,
  action: string,
  opts: MutationOptions | undefined,
  reason: string,
): void {
  if (opts?.expectedUpdatedAt === undefined) return;
  throw new HuduConfigError(
    `${resourcePath}.${action} does not accept expectedUpdatedAt (staleCheck is unavailable for it): ${reason}. ` +
      'The expectedUpdatedAt guard applies to update only.',
  );
}

export class ListsResource extends BaseResource<List> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'lists', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a lists by id. */
  async get(id: number): Promise<List> {
    return this.getOne<List>(id);
  }
  /** Stream lists across pages. */
  list(params?: ListsListParams): AsyncIterable<List> {
    return this.items(params ?? {});
  }
  /** Get every lists. MCP-preferred read. */
  async listAll(params?: ListsListParams): Promise<List[]> {
    return this.all(params ?? {});
  }
  /** Create a list. */
  async create(data: ListCreate): Promise<List>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: ListCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<List>>;
  /** Live create (no stale guard: `staleCheck` is unavailable for a create). */
  async create(data: ListCreate, opts: MutationOptions & { dryRun?: false }): Promise<List>;
  /** Options held in a variable: the caller must narrow the result. */
  async create(data: ListCreate, opts: MutationOptions | undefined): Promise<List | DryRunResult<List>>;
  async create(data: ListCreate, opts?: MutationOptions): Promise<List | DryRunResult<List>> {
    refuseExpectedUpdatedAt(this.resourcePath, 'create', opts, 'a create has no prior revision');
    return this.createOne<List>({ list: data }, undefined, opts);
  }
  /** Update a list. */
  async update(id: number, data: ListUpdate): Promise<List>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: ListUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<List>>;
  /** Live update, optionally with the opt-in stale guard. */
  async update(
    id: number,
    data: ListUpdate,
    opts: MutationOptions & { dryRun?: false },
  ): Promise<List>;
  /** Options held in a variable: the caller must narrow the result. */
  async update(id: number, data: ListUpdate, opts: MutationOptions | undefined): Promise<List | DryRunResult<List>>;
  async update(id: number, data: ListUpdate, opts?: MutationOptions): Promise<List | DryRunResult<List>> {
    return this.updateOne<List>(id, { list: data }, undefined, opts);
  }
  /** Delete a list. */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  /** Live delete, optionally with the opt-in stale guard. */
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    refuseExpectedUpdatedAt(this.resourcePath, 'delete', opts, 'a delete is bounded by its explicit id');
    return this.deleteOne(id, opts);
  }

  listPages(params?: ListsListParams): AsyncIterable<Page<List>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §6, §9). Compact shape: none — a List record is 5 fields.
  // ---------------------------------------------------------------------------

  /**
   * Resolve a list from an id or its exact name.
   *
   * Bare values are read in the documented order: numeric id, then exact name.
   * `{ id }` resolves directly and a miss throws NOT_FOUND — never null.
   * GET /lists is not paginated, so the name scan reads the collection once and
   * nothing is left unread; `null` therefore means "no list has that name".
   */
  async resolve(identifier: number | string | ListIdentifier): Promise<List | null>;
  async resolve(identifier: number | string | ListIdentifier, opts: { expand: true }): Promise<List | null>;
  async resolve(
    identifier: number | string | ListIdentifier,
    opts: { resolutionDetails: true },
  ): Promise<Resolution<List>>;
  async resolve(
    identifier: number | string | ListIdentifier,
    opts?: HelperOptions,
  ): Promise<List | null | Resolution<List>>;
  async resolve(
    identifier: number | string | ListIdentifier,
    opts: HelperOptions = {},
  ): Promise<List | null | Resolution<List>> {
    const operation = 'lists.resolve';
    const ref = readListIdentifier(identifier);
    if (ref.id !== undefined) {
      const record = await this.get(ref.id);
      if (opts.resolutionDetails) {
        return { value: record, resolutionCost: 'direct', scanned: 1, scanTruncated: false };
      }
      return record;
    }
    if (typeof ref.name === 'string' && ref.name.length > 0) {
      const resolution = await this.scanByName(ref.name, operation);
      if (opts.resolutionDetails) return resolution;
      return BaseResource.requireResolved<List>(resolution, {
        resource: this.resourcePath,
        operation,
        identifier: ref.name,
      });
    }
    throw new HuduConfigError(
      `lists.resolve accepts a numeric id, an exact name, { id } or { name }; ${JSON.stringify(identifier)} matches none`,
    );
  }

  /**
   * Find a list by its exact name (vendor `name` filter plus an exact compare).
   * `null` only after a complete scan; several matches throw RESOLUTION_AMBIGUOUS.
   */
  async findByName(name: string): Promise<List | null>;
  async findByName(name: string, opts: { resolutionDetails: true }): Promise<Resolution<List>>;
  async findByName(name: string, opts?: { resolutionDetails?: boolean }): Promise<List | null | Resolution<List>>;
  async findByName(
    name: string,
    opts: { resolutionDetails?: boolean } = {},
  ): Promise<List | null | Resolution<List>> {
    const operation = 'lists.findByName';
    const resolution = await this.scanByName(name, operation);
    if (opts.resolutionDetails) return resolution;
    return BaseResource.requireResolved<List>(resolution, {
      resource: this.resourcePath,
      operation,
      identifier: name,
    });
  }

  /** Bounded, vendor-filtered exact-name scan for one list. */
  private async scanByName(name: string, operation: string): Promise<Resolution<List>> {
    return this.scanUnique<List>(
      this.pageFetcher({ name }),
      (item) => item.name === name,
      (item) => `list "${item.name}"`,
      operation,
      `several lists are named "${name}"`,
    );
  }

  /**
   * One bounded, vendor-filtered exact-match scan plus a bounded uniqueness pass.
   *
   * `boundedScan` returns the FIRST match, so a second pass over the same filter is
   * what proves the match is unique; a second match is RESOLUTION_AMBIGUOUS with both
   * candidate ids. Both passes are bounded (500 records / 4 pages by default).
   */
  private async scanUnique<U extends { id: number }>(
    fetchPage: (page: number, pageSize: number) => Promise<Page<U>>,
    match: (item: U) => boolean,
    label: (item: U) => string,
    operation: string,
    ambiguity: string,
  ): Promise<Resolution<U>> {
    const idOf = (item: U): number => item.id;
    const first = await this.boundedScan<U>(fetchPage, {
      match,
      label,
      idOf,
      resolutionCost: 'server-filter',
    });
    if (first.value === null) return first;
    const firstId = idOf(first.value);
    const rest = await this.boundedScan<U>(fetchPage, {
      match: (item) => idOf(item) !== firstId && match(item),
      label,
      idOf,
      resolutionCost: 'server-filter',
    });
    if (rest.value !== null) {
      throw ResolutionError.ambiguous(`${operation}: ${ambiguity} (ids ${firstId}, ${idOf(rest.value)}).`, {
        operation,
        resourceIds: [firstId, idOf(rest.value)],
      });
    }
    // GET /lists is non-paginated: the fetcher never reports continuation, so the
    // uniqueness pass cannot be cut short by the page cap and cannot truncate. A
    // truncated result therefore only ever comes from the first pass, which returned
    // above — `scanTruncated` is false here by construction, never by assumption.
    return { ...first, scanned: first.scanned + rest.scanned };
  }
}
