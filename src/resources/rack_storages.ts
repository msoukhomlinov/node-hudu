/**
 * RackStoragesResource — Hudu "rack_storages" resource.
 *
 * Agent-execution-layer helper (policy §5-§6): `resolve` by id or exact name, plus
 * `{ dryRun: true }` and the opt-in `{ expectedUpdatedAt }` guard on the mutating
 * primitives. Existing primitives keep their signatures and return types.
 *
 * `/rack_storages` is NOT paginated: one request returns the whole collection, and
 * `page`/`page_size` must never reach it (asserted by the tests). Hudu declares no
 * `name` filter, so a name lookup is a bounded client scan (one complete read).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { RackStorage, RackStorageCreate, RackStorageUpdate } from '../types/index.js';
import type { RackStorageIdentifier, RackStorageSummary } from '../types/rack_storage.js';
import type {
  DryRunResult,
  HelperOptions,
  MutationOptions,
  Resolution,
} from '../types/common.js';
import { ResolutionError, ValidationFailedError } from '../errors.js';

export interface RackStoragesListParams extends ListParams {
  company_id?: number;
  location_id?: number;
  height?: number;
  min_width?: number;
  max_width?: number;
  created_at?: string;
  updated_at?: string;
}

/** Identifier kinds `rack_storages.resolve` accepts; named in every rejection. */
const ACCEPTED_RACK_KINDS = 'id, exact name';

/** Every rack lookup rejects an unsupported kind with the same structured error. */
function unsupportedRackIdentifier(received: string): ValidationFailedError {
  return new ValidationFailedError(
    `rack_storages.resolve: unsupported identifier (${received}). Accepted identifier kinds: ${ACCEPTED_RACK_KINDS}. ` +
      'Hudu declares no name filter on /rack_storages, so a name lookup is a bounded client scan, and no other kind is accepted.',
    undefined,
    undefined,
    {
      operation: 'rack_storages.resolve',
      suggestedAction: `Pass one of: ${ACCEPTED_RACK_KINDS}. An unsupported kind is rejected rather than guessed.`,
    },
  );
}

/** Candidate / log label for a rack storage. `name` is the field callers resolve by. */
function rackLabel(rack: RackStorage): string {
  return rack.name || String(rack.id);
}

/** Compact projection: keeps the lookup fields, drops the bulky ones (policy §9). */
function toRackSummary(rack: RackStorage): RackStorageSummary {
  return {
    id: rack.id,
    name: rack.name,
    company_id: rack.company_id,
    location_id: rack.location_id,
    height: rack.height,
    width: rack.width,
    max_wattage: rack.max_wattage,
    starting_unit: rack.starting_unit,
    updated_at: rack.updated_at,
  };
}

export class RackStoragesResource extends BaseResource<RackStorage> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'rack_storages', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a rack_storages by id. */
  async get(id: number): Promise<RackStorage> {
    return this.getOne<RackStorage>(id);
  }
  /** Stream rack_storages across pages. */
  list(params?: RackStoragesListParams): AsyncIterable<RackStorage> {
    return this.items(params ?? {});
  }
  /** Get every rack_storages. MCP-preferred read. */
  async listAll(params?: RackStoragesListParams): Promise<RackStorage[]> {
    return this.all(params ?? {});
  }
  async create(data: RackStorageCreate): Promise<RackStorage>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: RackStorageCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<RackStorage>>;
  async create(data: RackStorageCreate, opts: MutationOptions & { dryRun?: false }): Promise<RackStorage>;
  async create(data: RackStorageCreate, opts: MutationOptions | undefined): Promise<RackStorage | DryRunResult<RackStorage>>;
  async create(data: RackStorageCreate, opts?: MutationOptions): Promise<RackStorage | DryRunResult<RackStorage>> {
    return this.createOne<RackStorage>(data, undefined, opts);
  }
  async update(id: number, data: RackStorageUpdate): Promise<RackStorage>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: RackStorageUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<RackStorage>>;
  /** Live update, optionally with the opt-in stale guard. */
  async update(id: number, data: RackStorageUpdate, opts: MutationOptions & { dryRun?: false }): Promise<RackStorage>;
  async update(id: number, data: RackStorageUpdate, opts: MutationOptions | undefined): Promise<RackStorage | DryRunResult<RackStorage>>;
  async update(id: number, data: RackStorageUpdate, opts?: MutationOptions): Promise<RackStorage | DryRunResult<RackStorage>> {
    return this.updateOne<RackStorage>(id, data, undefined, opts);
  }
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  /** Live delete. */
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    // registry staleCheck for this row is "unavailable": `deleteOne` carries no
    // read-then-compare guard, and no other write path is involved.
    return this.deleteOne(id, opts);
  }

  listPages(params?: RackStoragesListParams): AsyncIterable<Page<RackStorage>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve a rack storage by id or exact name.
   *
   * An id is fetched directly and a miss throws NOT_FOUND (never `null`); a name is a
   * bounded client scan over the non-paginated collection with an exact compare
   * (`resolutionCost: 'client-scan'`). `null` means a complete scan found nothing; a
   * scan stopped by the record cap throws RESOLUTION_TRUNCATED, and several exact
   * matches throw RESOLUTION_AMBIGUOUS with the candidate ids.
   */
  async resolve(identifier: number | string | RackStorageIdentifier): Promise<RackStorageSummary | null>;
  /** Full record instead of the compact summary. */
  async resolve(identifier: number | string | RackStorageIdentifier, opts: { expand: true }): Promise<RackStorage | null>;
  /** `Resolution<RackStorageSummary>` (cost, scanned, scanTruncated, candidates). */
  async resolve(identifier: number | string | RackStorageIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<RackStorageSummary>>;
  /** `Resolution<RackStorage>` with the full record. */
  async resolve(identifier: number | string | RackStorageIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<RackStorage>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(
    identifier: number | string | RackStorageIdentifier,
    opts?: HelperOptions,
  ): Promise<RackStorage | RackStorageSummary | null | Resolution<RackStorage> | Resolution<RackStorageSummary>>;
  async resolve(
    identifier: number | string | RackStorageIdentifier,
    opts?: HelperOptions,
  ): Promise<RackStorage | RackStorageSummary | null | Resolution<RackStorage> | Resolution<RackStorageSummary>> {
    const resolution = await this.resolveRecord(identifier);
    if (opts?.resolutionDetails === true) {
      return opts.expand === true ? resolution : this.compactResolution(resolution);
    }
    if (resolution.value === null) return null;
    return opts?.expand === true ? resolution.value : toRackSummary(resolution.value);
  }

  /** Turn a resolved full record into the compact `Resolution` projection. */
  private compactResolution(resolution: Resolution<RackStorage>): Resolution<RackStorageSummary> {
    const compact: Resolution<RackStorageSummary> = {
      value: resolution.value === null ? null : toRackSummary(resolution.value),
      resolutionCost: resolution.resolutionCost,
      scanned: resolution.scanned,
      scanTruncated: resolution.scanTruncated,
    };
    if (resolution.candidates !== undefined) compact.candidates = resolution.candidates;
    return compact;
  }

  /** Documented kind order for a bare value, narrowed per identifier kind. */
  private async resolveRecord(identifier: number | string | RackStorageIdentifier): Promise<Resolution<RackStorage>> {
    if (typeof identifier === 'number') return this.resolveById(identifier);
    if (typeof identifier === 'string') {
      const value = identifier.trim();
      if (value.length === 0) throw unsupportedRackIdentifier('an empty string');
      if (/^\d+$/.test(value)) return this.resolveById(Number(value));
      return this.resolveByName(value);
    }
    if (identifier !== null && typeof identifier === 'object' && !Array.isArray(identifier)) {
      const { id, name } = identifier;
      if (id !== undefined) return this.resolveById(id);
      if (typeof name === 'string') return this.resolveByName(name.trim());
      throw unsupportedRackIdentifier(`an object with keys [${Object.keys(identifier).join(', ')}]`);
    }
    throw unsupportedRackIdentifier(String(identifier));
  }

  /** Direct fetch. An id is a definite reference: a miss throws NOT_FOUND. */
  private async resolveById(id: number): Promise<Resolution<RackStorage>> {
    if (!Number.isInteger(id) || id < 1) throw unsupportedRackIdentifier(String(id));
    const record = await this.getOne<RackStorage>(id);
    return {
      value: record,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: record.id, label: rackLabel(record) }],
    };
  }

  /** Name lookup: no vendor filter exists, so one complete bounded collection read. */
  private async resolveByName(name: string): Promise<Resolution<RackStorage>> {
    if (name.length === 0) throw unsupportedRackIdentifier('an empty name');
    const scan = await this.exactScan({}, (item) => item.name === name);
    return this.decide(scan.matches, scan.scanned, scan.truncated, `name "${name}"`);
  }

  /**
   * Bounded exact-match scan over the non-paginated collection (policy §6).
   *
   * The record cap is enforced by trimming the fetched page and reporting `hasMore`,
   * so a collection larger than the cap is reported as a truncated scan instead of a
   * false "no match". One HTTP request maximum; `page`/`page_size` never reach the wire.
   */
  private async exactScan(
    query: RackStoragesListParams,
    predicate: (item: RackStorage) => boolean,
  ): Promise<{ matches: RackStorage[]; scanned: number; truncated: boolean }> {
    const cap = this.http.resolution.maxScanRecords;
    const fetcher = this.pageFetcher(query);
    const matches: RackStorage[] = [];
    let examined = 0;
    const capped = async (page: number, pageSize: number): Promise<Page<RackStorage>> => {
      const result = await fetcher(page, pageSize);
      const remaining = Math.max(cap - examined, 0);
      if (result.items.length > remaining) {
        examined += remaining;
        return { items: result.items.slice(0, remaining), page: result.page, page_size: result.page_size, hasMore: true };
      }
      examined += result.items.length;
      return result;
    };
    const resolution = await this.boundedScan<RackStorage>(capped, {
      match: (item) => {
        if (predicate(item)) matches.push(item);
        return false;
      },
      label: rackLabel,
      resolutionCost: 'client-scan',
      maxScanPages: 1,
      maxScanRecords: cap,
    });
    return { matches, scanned: resolution.scanned, truncated: resolution.scanTruncated };
  }

  /** Policy §6 decision: unique match, honest `null`, or a structured throw. */
  private decide(
    matches: RackStorage[],
    scanned: number,
    truncated: boolean,
    descriptor: string,
  ): Resolution<RackStorage> {
    if (truncated) {
      throw ResolutionError.truncated(
        `Client scan for rack_storages was truncated after ${scanned} record(s) while resolving ${descriptor}; ` +
          'a match may exist beyond the scan cap, so the lookup is undecided.',
        {
          operation: 'rack_storages.resolve',
          resourceIds: matches.map((match) => match.id),
          suggestedAction: 'Resolve by { id }, or raise resolution.maxScanRecords/maxScanPages.',
        },
      );
    }
    const candidates = matches.map((match) => ({ id: match.id, label: rackLabel(match) }));
    if (matches.length > 1) {
      throw ResolutionError.ambiguous(
        `Ambiguous rack_storages.resolve for ${descriptor}: ${matches.length} rack storages match exactly.`,
        { operation: 'rack_storages.resolve', resourceIds: candidates.map((candidate) => candidate.id) },
      );
    }
    const value = matches.length === 1 ? (matches[0] as RackStorage) : null;
    const resolution: Resolution<RackStorage> = {
      value,
      resolutionCost: 'client-scan',
      scanned,
      scanTruncated: false,
    };
    if (value !== null) resolution.candidates = candidates;
    return resolution;
  }
}
