/**
 * LabelTypesResource — Hudu "label_types" resource.
 *
 * Agent-execution-layer tier (policy §5-§9): the `resolve` helper (compact
 * `LabelTypeSummary` by default), dry-run on the mutations and the opt-in
 * `expectedUpdatedAt` stale guard.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError, ResolutionError } from '../errors.js';
import type { DryRunResult, MutationOptions, Resolution } from '../types/common.js';
import type { LabelType, LabelTypeCreate, LabelTypeUpdate } from '../types/index.js';
import type { LabelTypeIdentifier, LabelTypeSummary } from '../types/label_type.js';

/**
 * Options for `resolve`: the compact/full switch and the `Resolution` wrapper. No
 * `limit` — resolve returns ONE label type; no other option is accepted and ignored.
 */
export interface LabelTypesResolveOptions {
  expand?: boolean;
  resolutionDetails?: boolean;
}

export interface LabelTypesListParams extends ListParams {
  name?: string;
  color?: string;
  slug?: string;
  created_at?: string;
  updated_at?: string;
}

/** Identifier kinds this resource can honour, in the documented order. */
interface LabelTypeRef {
  id?: number;
  slug?: string;
  name?: string;
  /** True when the caller passed a bare string: try `slug`, then the exact `name`. */
  bare?: string;
}

/** Read the id/slug/name a caller supplied, without guessing a kind the vendor cannot support. */
function readLabelTypeIdentifier(identifier: number | string | LabelTypeIdentifier): LabelTypeRef {
  if (typeof identifier === 'number') return { id: identifier };
  if (typeof identifier === 'string') {
    return /^\d+$/.test(identifier.trim())
      ? { id: Number(identifier.trim()) }
      : { bare: identifier };
  }
  return { id: identifier.id, slug: identifier.slug, name: identifier.name };
}

/** Compact projection: keeps what an agent needs, drops the rest of the record. */
function toLabelTypeSummary(labelType: LabelType): LabelTypeSummary {
  return {
    id: labelType.id,
    name: labelType.name,
    slug: labelType.slug,
    color: labelType.color,
    applicable_record_types: labelType.applicable_record_types,
    access_level: labelType.access_level,
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

export class LabelTypesResource extends BaseResource<LabelType> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'label_types', singleKey: 'label_type', listKey: 'label_types', createType: 'wrapped', paginated: true });
  }

  /** Get a label_types by id. */
  async get(id: number): Promise<LabelType> {
    return this.getOne<LabelType>(id);
  }
  /** Stream label_types across pages. */
  list(params?: LabelTypesListParams): AsyncIterable<LabelType> {
    return this.items(params ?? {});
  }
  /** Get every label_types. MCP-preferred read. */
  async listAll(params?: LabelTypesListParams): Promise<LabelType[]> {
    return this.all(params ?? {});
  }
  /** Create a label type. */
  async create(data: LabelTypeCreate): Promise<LabelType>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: LabelTypeCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<LabelType>>;
  /** Live create (no stale guard: `staleCheck` is unavailable for a create). */
  async create(data: LabelTypeCreate, opts: MutationOptions & { dryRun?: false }): Promise<LabelType>;
  /** Options held in a variable: the caller must narrow the result. */
  async create(data: LabelTypeCreate, opts: MutationOptions | undefined): Promise<LabelType | DryRunResult<LabelType>>;
  async create(data: LabelTypeCreate, opts?: MutationOptions): Promise<LabelType | DryRunResult<LabelType>> {
    refuseExpectedUpdatedAt(this.resourcePath, 'create', opts, 'a create has no prior revision');
    return this.createOne<LabelType>({ label_type: data }, undefined, opts);
  }
  /** Update a label type. */
  async update(id: number, data: LabelTypeUpdate): Promise<LabelType>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: LabelTypeUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<LabelType>>;
  /** Live update, optionally with the opt-in stale guard. */
  async update(id: number, data: LabelTypeUpdate, opts: MutationOptions & { dryRun?: false }): Promise<LabelType>;
  /** Options held in a variable: the caller must narrow the result. */
  async update(
    id: number,
    data: LabelTypeUpdate,
    opts: MutationOptions | undefined,
  ): Promise<LabelType | DryRunResult<LabelType>>;
  async update(
    id: number,
    data: LabelTypeUpdate,
    opts?: MutationOptions,
  ): Promise<LabelType | DryRunResult<LabelType>> {
    return this.updateOne<LabelType>(id, { label_type: data }, undefined, opts);
  }
  /** Delete a label type. */
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

  listPages(params?: LabelTypesListParams): AsyncIterable<Page<LabelType>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §6, §9). Compact shape: LabelTypeSummary.
  // ---------------------------------------------------------------------------

  /**
   * Resolve a label type from an id, a slug or an exact name.
   *
   * Bare values are read in the documented order: numeric id, slug, exact name.
   * `{ id }` resolves directly and a miss throws NOT_FOUND — never null.
   * `null` means a COMPLETE scan found nothing; a scan the cap stopped throws
   * RESOLUTION_TRUNCATED. Several exact matches throw RESOLUTION_AMBIGUOUS.
   */
  async resolve(identifier: number | string | LabelTypeIdentifier): Promise<LabelTypeSummary | null>;
  async resolve(identifier: number | string | LabelTypeIdentifier, opts: { expand: true }): Promise<LabelType | null>;
  async resolve(
    identifier: number | string | LabelTypeIdentifier,
    opts: { resolutionDetails: true },
  ): Promise<Resolution<LabelTypeSummary>>;
  async resolve(
    identifier: number | string | LabelTypeIdentifier,
    opts?: LabelTypesResolveOptions,
  ): Promise<LabelType | LabelTypeSummary | null | Resolution<LabelTypeSummary>>;
  async resolve(
    identifier: number | string | LabelTypeIdentifier,
    opts: LabelTypesResolveOptions = {},
  ): Promise<LabelType | LabelTypeSummary | null | Resolution<LabelTypeSummary>> {
    const operation = 'label_types.resolve';
    const ref = readLabelTypeIdentifier(identifier);
    if (ref.id !== undefined) {
      const record = await this.get(ref.id);
      const delivered = opts.expand ? record : toLabelTypeSummary(record);
      if (opts.resolutionDetails) {
        return { value: delivered, resolutionCost: 'direct', scanned: 1, scanTruncated: false };
      }
      return delivered;
    }
    const stages: Array<['slug' | 'name', string]> = [];
    if (typeof ref.bare === 'string') {
      stages.push(['slug', ref.bare], ['name', ref.bare]);
    } else if (typeof ref.slug === 'string') {
      stages.push(['slug', ref.slug]);
    } else if (typeof ref.name === 'string') {
      stages.push(['name', ref.name]);
    }
    if (stages.length === 0) {
      throw new HuduConfigError(
        `label_types.resolve accepts a numeric id, a slug, an exact name, { id }, { slug } or { name }; ` +
          `${JSON.stringify(identifier)} matches none`,
      );
    }
    let resolution: Resolution<LabelType> | undefined;
    let scanned = 0;
    for (const [kind, value] of stages) {
      const attempt = await this.scanBy(kind, value, operation);
      scanned += attempt.scanned;
      // A truncated attempt is undecided — never treat it as a miss for the next stage.
      if (attempt.value !== null || attempt.scanTruncated) {
        resolution = attempt;
        break;
      }
    }
    const found: Resolution<LabelType> =
      resolution ?? { value: null, resolutionCost: 'server-filter', scanned, scanTruncated: false };
    if (opts.resolutionDetails) {
      return opts.expand ? found : projectResolution(found, toLabelTypeSummary);
    }
    const value = BaseResource.requireResolved<LabelType>(found, {
      resource: this.resourcePath,
      operation,
      identifier: ref.id ?? ref.slug ?? ref.name,
    });
    return value === null ? null : opts.expand ? value : toLabelTypeSummary(value);
  }

  /** One bounded, vendor-filtered stage of the resolve lookup. */
  private async scanBy(
    kind: 'slug' | 'name',
    value: string,
    operation: string,
  ): Promise<Resolution<LabelType>> {
    return this.scanUnique<LabelType>(
      this.pageFetcher({ [kind]: value }),
      (item) => item[kind] === value,
      (item) => `label type "${item.name}" (slug ${item.slug})`,
      operation,
      `several label types match ${kind} "${value}"`,
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
