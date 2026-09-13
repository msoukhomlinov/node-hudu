/**
 * LabelsResource — Hudu "labels" resource.
 *
 * Agent-execution-layer tier (policy §5-§9): `resolve` (by id or by the record a label
 * is attached to) and `findByLabelable`, plus dry-run and the opt-in `expectedUpdatedAt`
 * stale guard on the mutations.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError, ResolutionError } from '../errors.js';
import { identifierError } from './agent-layer-helpers.js';

/** What `labels.resolve` accepts, named in every refusal. */
const ACCEPTED_LABEL_KINDS = 'a numeric id, { id } or { labelableType, labelableId }';
import type { DryRunResult, MutationOptions, Resolution } from '../types/common.js';
import type { Label, LabelCreate, LabelUpdate } from '../types/index.js';
import type { LabelIdentifier, LabelSummary } from '../types/label.js';

/**
 * Options for `resolve`: the compact/full switch and the `Resolution` wrapper. No
 * `limit` — resolve returns ONE label; no other option is accepted and ignored.
 */
export interface LabelsResolveOptions {
  expand?: boolean;
  resolutionDetails?: boolean;
}

/**
 * Options for `findByLabelable`: the row cap (default 25, hard maximum 100) and the
 * compact/full switch. It returns an ARRAY, so no `Resolution` wrapper is offered.
 */
export interface LabelsFindByLabelableOptions {
  limit?: number;
  expand?: boolean;
}

export interface LabelsListParams extends ListParams {
  label_type_id?: number;
  labelable_type?: string;
  labelable_id?: number;
  user_id?: number;
  created_at?: string;
  updated_at?: string;
}

/** Helper-tier row cap: default 25, hard maximum 100 (policy §9). */
const DEFAULT_HELPER_LIMIT = 25;
const MAX_HELPER_LIMIT = 100;

function helperLimit(requested: number | undefined): number {
  const limit = requested ?? DEFAULT_HELPER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HuduConfigError(`limit must be a positive integer, got "${String(requested)}"`);
  }
  if (limit > MAX_HELPER_LIMIT) {
    throw new HuduConfigError(`limit must be <= ${MAX_HELPER_LIMIT} for the helper tier, got ${limit}`);
  }
  return limit;
}

/** Read the id / labelable pair a caller supplied, without guessing a kind the vendor cannot support. */
function readLabelIdentifier(identifier: number | string | LabelIdentifier): {
  id?: number;
  labelableType?: string;
  labelableId?: number;
} {
  // Live-verified: `labels.resolve(undefined)` read `.id` off `undefined` and threw a RAW TypeError.
  if (identifier === null || identifier === undefined) {
    throw identifierError('labels.resolve', ACCEPTED_LABEL_KINDS);
  }
  if (typeof identifier === 'number') return { id: identifier };
  if (typeof identifier === 'string') {
    return /^\d+$/.test(identifier.trim()) ? { id: Number(identifier.trim()) } : {};
  }
  return {
    id: identifier.id,
    labelableType: identifier.labelableType,
    labelableId: identifier.labelableId,
  };
}

/** Compact projection: keeps what an agent needs, drops the rest of the record. */
function toLabelSummary(label: Label): LabelSummary {
  return {
    id: label.id,
    label_type_id: label.label_type_id,
    labelable_type: label.labelable_type,
    labelable_id: label.labelable_id,
    user_id: label.user_id,
    updated_at: label.updated_at,
  };
}

/** Map a resolution's value through a projection, keeping cost/scanned/candidates. */
function projectResolution<T, S>(resolution: Resolution<T>, project: (item: T) => S): Resolution<S> {
  return { ...resolution, value: resolution.value === null ? null : project(resolution.value) };
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

export class LabelsResource extends BaseResource<Label> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'labels', singleKey: 'label', listKey: 'labels', createType: 'wrapped', paginated: true });
  }

  /** Get a labels by id. */
  async get(id: number): Promise<Label> {
    return this.getOne<Label>(id);
  }
  /** Stream labels across pages. */
  list(params?: LabelsListParams): AsyncIterable<Label> {
    return this.items(params ?? {});
  }
  /** Get every labels. MCP-preferred read. */
  async listAll(params?: LabelsListParams): Promise<Label[]> {
    return this.all(params ?? {});
  }
  /** Create a label. */
  async create(data: LabelCreate): Promise<Label>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: LabelCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Label>>;
  /** Live create (no stale guard: `staleCheck` is unavailable for a create). */
  async create(data: LabelCreate, opts: MutationOptions & { dryRun?: false }): Promise<Label>;
  /** Options held in a variable: the caller must narrow the result. */
  async create(data: LabelCreate, opts: MutationOptions | undefined): Promise<Label | DryRunResult<Label>>;
  async create(data: LabelCreate, opts?: MutationOptions): Promise<Label | DryRunResult<Label>> {
    refuseExpectedUpdatedAt(this.resourcePath, 'create', opts, 'a create has no prior revision');
    return this.createOne<Label>({ label: data }, undefined, opts);
  }
  /** Update a label. */
  async update(id: number, data: LabelUpdate): Promise<Label>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: LabelUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Label>>;
  /** Live update, optionally with the opt-in stale guard. */
  async update(id: number, data: LabelUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Label>;
  /** Options held in a variable: the caller must narrow the result. */
  async update(id: number, data: LabelUpdate, opts: MutationOptions | undefined): Promise<Label | DryRunResult<Label>>;
  async update(id: number, data: LabelUpdate, opts?: MutationOptions): Promise<Label | DryRunResult<Label>> {
    return this.updateOne<Label>(id, { label: data }, undefined, opts);
  }
  /** Delete a label. */
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

  listPages(params?: LabelsListParams): AsyncIterable<Page<Label>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §6, §9). Compact shape: LabelSummary.
  // ---------------------------------------------------------------------------

  /**
   * Resolve one label by its id or by the record it is attached to.
   *
   * Labels have no `name` field, so the accepted kinds are numeric `id` (fetched
   * directly; a miss throws NOT_FOUND, never null) and `{ labelableType, labelableId }`
   * (vendor server filters). A record can carry several labels: resolve then throws
   * RESOLUTION_AMBIGUOUS with the candidate ids in `resourceIds`.
   */
  async resolve(identifier: number | string | LabelIdentifier): Promise<LabelSummary | null>;
  async resolve(identifier: number | string | LabelIdentifier, opts: { expand: true }): Promise<Label | null>;
  async resolve(
    identifier: number | string | LabelIdentifier,
    opts: { resolutionDetails: true },
  ): Promise<Resolution<LabelSummary>>;
  async resolve(
    identifier: number | string | LabelIdentifier,
    opts?: LabelsResolveOptions,
  ): Promise<Label | LabelSummary | null | Resolution<LabelSummary>>;
  async resolve(
    identifier: number | string | LabelIdentifier,
    opts: LabelsResolveOptions = {},
  ): Promise<Label | LabelSummary | null | Resolution<LabelSummary>> {
    const operation = 'labels.resolve';
    const ref = readLabelIdentifier(identifier);
    if (ref.id !== undefined) {
      const record = await this.get(ref.id);
      const delivered = opts.expand ? record : toLabelSummary(record);
      if (opts.resolutionDetails) {
        return { value: delivered, resolutionCost: 'direct', scanned: 1, scanTruncated: false };
      }
      return delivered;
    }
    if (typeof ref.labelableType === 'string' && typeof ref.labelableId === 'number') {
      const found = await this.scanUnique<Label>(
        this.pageFetcher({ labelable_type: ref.labelableType, labelable_id: ref.labelableId }),
        // The server filter narrows to the pair; the exact compare decides, so a
        // server that ignores the filter can never be mistaken for a unique match.
        (item) => item.labelable_type === ref.labelableType && item.labelable_id === ref.labelableId,
        (item) => `label ${item.id} (label_type ${item.label_type_id})`,
        operation,
        `several labels are attached to ${ref.labelableType} ${ref.labelableId}`,
      );
      if (opts.resolutionDetails) {
        return opts.expand ? found : projectResolution(found, toLabelSummary);
      }
      const value = BaseResource.requireResolved<Label>(found, {
        resource: this.resourcePath,
        operation,
        identifier: ref.id ?? ref.labelableId,
      });
      return value === null ? null : opts.expand ? value : toLabelSummary(value);
    }
    throw new HuduConfigError(
      'labels.resolve accepts a numeric id, { id } or { labelableType, labelableId }; a label has no name, ' +
        `so ${JSON.stringify(identifier)} cannot be resolved`,
    );
  }

  /**
   * List the labels attached to one record (vendor `labelable_type` + `labelable_id`).
   * Returns LabelSummary records (limit default 25, hard maximum 100); `expand: true`
   * returns the full records.
   */
  async findByLabelable(
    labelableType: string,
    labelableId: number,
    opts?: LabelsFindByLabelableOptions & { expand?: false },
  ): Promise<LabelSummary[]>;
  async findByLabelable(
    labelableType: string,
    labelableId: number,
    opts: LabelsFindByLabelableOptions & { expand: true },
  ): Promise<Label[]>;
  async findByLabelable(
    labelableType: string,
    labelableId: number,
    opts: LabelsFindByLabelableOptions | undefined,
  ): Promise<Label[] | LabelSummary[]>;
  async findByLabelable(
    labelableType: string,
    labelableId: number,
    opts: LabelsFindByLabelableOptions = {},
  ): Promise<Label[] | LabelSummary[]> {
    const limit = helperLimit(opts.limit);
    // One page of exactly `limit` rows: the helper never pulls more than the caller asked for.
    const fetchPage = this.pageFetcher({
      labelable_type: labelableType,
      labelable_id: labelableId,
      page_size: limit,
    });
    const page = await fetchPage(1, limit);
    const items = page.items.slice(0, limit);
    return opts.expand ? items : items.map(toLabelSummary);
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
    if (rest.scanTruncated) {
      // The uniqueness pass hit its cap: "no second match" is undecided, never a null.
      return {
        value: null,
        resolutionCost: 'server-filter',
        scanned: first.scanned + rest.scanned,
        scanTruncated: true,
      };
    }
    return { ...first, scanned: first.scanned + rest.scanned };
  }
}
