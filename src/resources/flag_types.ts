/**
 * FlagTypesResource — Hudu "flag_types" resource.
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
import type { FlagType, FlagTypeCreate, FlagTypeSummary, FlagTypeUpdate } from '../types/flag_type.js';

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


export interface FlagTypesListParams extends ListParams {
  name?: string;
  color?: string;
  slug?: string;
  created_at?: string;
  updated_at?: string;
}

/** One vendor-filtered lookup `flag_types.resolve` performs, in the documented kind order. */
type FlagTypeFilterLookup = { kind: 'slug'; slug: string } | { kind: 'name'; name: string };

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

/**
 * Classify an identifier into the documented kind order (policy §6): **numeric id, then slug,
 * then exact name**. Anything else throws a structured validation error naming the accepted kinds
 * instead of guessing.
 */
function classifyFlagTypeIdentifier(identifier: Identifier): { direct?: number; lookups: FlagTypeFilterLookup[] } {
  if (typeof identifier === 'number') {
    if (Number.isInteger(identifier) && identifier > 0) return { direct: identifier, lookups: [] };
  } else if (typeof identifier === 'string') {
    if (/^\d+$/.test(identifier)) return { direct: Number(identifier), lookups: [] };
    if (identifier.length > 0) {
      return { lookups: [{ kind: 'slug', slug: identifier }, { kind: 'name', name: identifier }] };
    }
  } else if (typeof identifier === 'object' && identifier !== null) {
    const obj = identifier as IdentifierObject;
    if (typeof obj.id === 'number' && Number.isInteger(obj.id) && obj.id > 0) return { direct: obj.id, lookups: [] };
    if (typeof obj.slug === 'string' && obj.slug.length > 0) return { lookups: [{ kind: 'slug', slug: obj.slug }] };
    if (typeof obj.name === 'string' && obj.name.length > 0) return { lookups: [{ kind: 'name', name: obj.name }] };
  }
  throw new HuduConfigError(
    'flag_types.resolve accepts a numeric id, a slug, or an exact name (a bare number or non-empty ' +
      'string, or { id: number } / { slug: string } / { name: string }); got ' +
      `${describeValue(identifier)}.`,
  );
}

/** Disambiguation label for one flag type. */
function flagTypeLabel(flagType: FlagType): string {
  return `#${flagType.id} ${flagType.name} (${flagType.slug})`;
}

/** Compact projection (policy §9): drops created_at and updated_at. */
function toFlagTypeSummary(flagType: FlagType): FlagTypeSummary {
  return {
    id: flagType.id,
    name: flagType.name,
    slug: flagType.slug,
    color: flagType.color,
  };
}

export class FlagTypesResource extends BaseResource<FlagType> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'flag_types', singleKey: 'flag_type', listKey: 'flag_types', createType: 'wrapped', paginated: true });
  }

  /** Get a flag_types by id. */
  async get(id: number): Promise<FlagType> {
    return this.getOne<FlagType>(id);
  }
  /** Stream flag_types across pages. */
  list(params?: FlagTypesListParams): AsyncIterable<FlagType> {
    return this.items(params ?? {});
  }
  /** Get every flag_types. MCP-preferred read. */
  async listAll(params?: FlagTypesListParams): Promise<FlagType[]> {
    return this.all(params ?? {});
  }

  /**
   * Create a flag_types record. `staleCheck` is `"unavailable"` for a create: a new record has no prior
   * revision to be stale against, so the opt-in `expectedUpdatedAt` guard is not part of this path and
   * supplying it is refused with `HuduConfigError` (never silently ignored, never a false STALE_OBJECT).
   */
  async create(data: FlagTypeCreate): Promise<FlagType>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: FlagTypeCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<FlagType>>;
  async create(data: FlagTypeCreate, opts: MutationOptions & { dryRun?: false }): Promise<FlagType>;
  async create(data: FlagTypeCreate, opts: MutationOptions | undefined): Promise<FlagType | DryRunResult<FlagType>>;
  async create(data: FlagTypeCreate, opts?: MutationOptions): Promise<FlagType | DryRunResult<FlagType>> {
    refuseExpectedUpdatedAt('flag_types.create', opts);
    return this.createOne<FlagType>({ flag_type: data }, undefined, opts);
  }

  /** Update a flag_types record (PUT response unwrapped by singleKey; opt-in `expectedUpdatedAt` guard). */
  async update(id: number, data: FlagTypeUpdate): Promise<FlagType>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: FlagTypeUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<FlagType>>;
  async update(id: number, data: FlagTypeUpdate, opts: MutationOptions & { dryRun?: false }): Promise<FlagType>;
  async update(id: number, data: FlagTypeUpdate, opts: MutationOptions | undefined): Promise<FlagType | DryRunResult<FlagType>>;
  async update(id: number, data: FlagTypeUpdate, opts?: MutationOptions): Promise<FlagType | DryRunResult<FlagType>> {
    return this.updateOne<FlagType>(id, { flag_type: data }, undefined, opts);
  }

  /**
   * Delete a flag_types record. `staleCheck` is `"unavailable"` here: the delete is bounded by the
   * explicit id and Hudu exposes no conditional delete, so no `expectedUpdatedAt` read is made and
   * supplying the option is refused with `HuduConfigError`.
   */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    refuseExpectedUpdatedAt('flag_types.delete', opts);
    return this.deleteOne(id, opts);
  }

  listPages(params?: FlagTypesListParams): AsyncIterable<Page<FlagType>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve a flag type from an identifier.
   *
   * Accepted kinds, in this order: **numeric id** (direct `GET /flag_types/{id}`, no scan, and an
   * id miss throws `NOT_FOUND`), then **slug**, then **exact name** — the last two through the
   * vendor's `slug` / `name` filters, each bounded and exact-match only. A bare non-numeric string
   * is tried as a slug first and then as an exact name.
   *
   * - a complete search with no match returns `null`
   * - several exact matches throw `RESOLUTION_AMBIGUOUS` with the candidate ids in `resourceIds`
   * - a search stopped by its cap throws `RESOLUTION_TRUNCATED` — never `null`
   *
   * Default return is {@link FlagTypeSummary}; `{ expand: true }` returns the full record,
   * `{ resolutionDetails: true }` returns a `Resolution<FlagTypeSummary>`.
   */
  async resolve(identifier: Identifier): Promise<FlagTypeSummary | null>;
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<FlagType | null>;
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<FlagTypeSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: HelperOptions | ResolutionOptions,
  ): Promise<FlagType | FlagTypeSummary | Resolution<FlagTypeSummary> | null>;
  async resolve(
    identifier: Identifier,
    opts?: HelperOptions | ResolutionOptions,
  ): Promise<FlagType | FlagTypeSummary | Resolution<FlagTypeSummary> | null> {
    const { direct, lookups } = classifyFlagTypeIdentifier(identifier);

    if (direct !== undefined) {
      let record: FlagType;
      try {
        record = await this.getOne<FlagType>(direct);
      } catch (err) {
        if (err instanceof NotFoundError) {
          throw new NotFoundError(`flag_types.resolve: no flag type with id ${direct}`, err.url, err.body, {
            operation: 'flag_types.resolve',
            resourceIds: [direct],
            correlationId: err.correlationId,
          });
        }
        throw err;
      }
      if (opts?.resolutionDetails === true) {
        return { value: toFlagTypeSummary(record), resolutionCost: 'direct', scanned: 1, scanTruncated: false };
      }
      return opts?.expand === true ? record : toFlagTypeSummary(record);
    }

    // Filtered kinds, in the documented order. Each lookup is bounded; the first complete miss
    // falls through to the next kind, and a hit is decided by the vendor filter plus an exact compare.
    let scanned = 0;
    let hit: Resolution<FlagType> | undefined;
    let truncated: Resolution<FlagType> | undefined;
    for (const lookup of lookups) {
      const resolution = await this.lookupByFilter(lookup);
      scanned += resolution.scanned;
      if ((resolution.candidates?.length ?? 0) > 1) {
        const candidates = resolution.candidates ?? [];
        throw ResolutionError.ambiguous(
          `flag_types.resolve: ${candidates.length} flag types match ` +
            `${describeValue(lookup.kind === 'slug' ? lookup.slug : lookup.name)} exactly.`,
          {
            operation: 'flag_types.resolve',
            resourceIds: candidates.map((candidate) => candidate.id),
            suggestedAction: 'Pass { id } or a unique slug from resourceIds.',
          },
        );
      }
      if (resolution.value !== null) {
        hit = resolution;
        break;
      }
      if (resolution.scanTruncated) {
        truncated = resolution;
        break;
      }
    }
    if (hit === undefined && truncated !== undefined) {
      // A cap stopped the search before the data ran out: returning null here would be a lie.
      BaseResource.requireResolved(truncated, {
        resource: this.resourcePath,
        operation: 'flag_types.resolve',
        identifier,
      });
    }
    const resolved: Resolution<FlagType> =
      hit === undefined
        ? { value: null, resolutionCost: 'server-filter', scanned, scanTruncated: false }
        : {
            value: hit.value,
            resolutionCost: hit.resolutionCost,
            scanned,
            scanTruncated: hit.scanTruncated,
            ...(hit.candidates === undefined ? {} : { candidates: hit.candidates }),
          };
    if (opts?.resolutionDetails === true) {
      return {
        value:
          resolved.value === null ? null : opts.expand === true ? resolved.value : toFlagTypeSummary(resolved.value),
        resolutionCost: resolved.resolutionCost,
        scanned: resolved.scanned,
        scanTruncated: resolved.scanTruncated,
        ...(resolved.candidates === undefined ? {} : { candidates: resolved.candidates }),
      };
    }
    const record = BaseResource.requireResolved(resolved, {
      resource: this.resourcePath,
      operation: 'flag_types.resolve',
      identifier,
    });
    if (record === null) return null;
    return opts?.expand === true ? record : toFlagTypeSummary(record);
  }

  /**
   * One bounded, exact-match lookup through a vendor filter (policy §6). The scan examines at most
   * `resolution.maxScanRecords` records over at most `resolution.maxScanPages` pages and reports
   * what it actually did; every exact match found inside that bound is reported as a candidate, so
   * a filter that is not unique is surfaced as `RESOLUTION_AMBIGUOUS` instead of silently picking one.
   */
  private async lookupByFilter(lookup: FlagTypeFilterLookup): Promise<Resolution<FlagType>> {
    let filter: Record<string, unknown>;
    let matches: (candidate: FlagType) => boolean;
    if (lookup.kind === 'slug') {
      const slug = lookup.slug;
      filter = { slug };
      matches = (candidate) => candidate.slug === slug;
    } else {
      const name = lookup.name;
      filter = { name };
      matches = (candidate) => candidate.name === name;
    }
    const found: FlagType[] = [];
    const resolution = await this.boundedScan<FlagType>(this.pageFetcher(filter), {
      match: (candidate) => {
        if (matches(candidate)) found.push(candidate);
        return false;
      },
      label: flagTypeLabel,
      idOf: (candidate) => candidate.id,
      resolutionCost: 'server-filter',
    });
    if (found.length === 0) return resolution;
    return {
      value: found[0] as FlagType,
      resolutionCost: resolution.resolutionCost,
      scanned: resolution.scanned,
      scanTruncated: resolution.scanTruncated,
      candidates: found.map((candidate) => ({ id: candidate.id, label: flagTypeLabel(candidate) })),
    };
  }
}
