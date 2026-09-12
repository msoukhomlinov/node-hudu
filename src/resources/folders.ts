/**
 * FoldersResource — Hudu "folders" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Folder, FolderCreate, FolderIdentifier, FolderSummary, FolderUpdate } from '../types/folder.js';
import type { DryRunResult, HelperOptions, MutationOptions, Resolution } from '../types/common.js';
import { HuduConfigError, ResolutionError, ValidationFailedError } from '../errors.js';

export interface FoldersListParams extends ListParams {
  name?: string;
  company_id?: number;
  in_company?: boolean;
  folder_type?: string;
}

/** One bounded, vendor-filtered scan for exact matches. */
interface ExactScan<T> {
  matches: T[];
  scanned: number;
  scanTruncated: boolean;
}

/** The compact projection of a folder record (`FolderSummary`). */
function toFolderSummary(record: Folder): FolderSummary {
  return {
    id: record.id,
    name: record.name,
    company_id: record.company_id,
    parent_folder_id: record.parent_folder_id,
    folder_type: record.folder_type,
    icon: record.icon,
    updated_at: record.updated_at,
  };
}

/** The identifier kinds `folders.resolve` accepts (documented in the registry `usage`). */
const ACCEPTED_KINDS =
  'a bare id/name or an object with one of { id } or { name }, optionally narrowed by company_id and folder_type';

/** Vendor filters that may accompany a name lookup. */
interface FolderNarrowing {
  company_id?: number | null;
  folder_type?: string;
}

/** A normalized lookup for `resolve`. */
type FolderLookup =
  | { kind: 'id'; id: number }
  | { kind: 'name'; name: string; narrow: FolderNarrowing }
  | { kind: 'bare'; value: string };

/** Normalize the accepted identifier forms, refusing anything the vendor cannot support. */
function folderLookup(identifier: number | string | FolderIdentifier): FolderLookup {
  if (typeof identifier === 'number') {
    if (!Number.isInteger(identifier) || identifier < 1) {
      throw new ValidationFailedError(
        `folders.resolve: expected a positive integer id, got "${String(identifier)}"; accepted: ${ACCEPTED_KINDS}`,
      );
    }
    return { kind: 'id', id: identifier };
  }
  if (typeof identifier === 'string') {
    const text = identifier.trim();
    if (text.length === 0) {
      throw new ValidationFailedError(`folders.resolve: expected a non-empty identifier; accepted: ${ACCEPTED_KINDS}`);
    }
    return /^\d+$/.test(text) ? { kind: 'id', id: Number(text) } : { kind: 'bare', value: text };
  }
  const raw = identifier as Record<string, unknown>;
  const has = (key: string): boolean => raw[key] !== undefined && raw[key] !== null;
  if (has('id') && has('name')) {
    throw new ValidationFailedError('folders.resolve: pass { id } or { name }, not both');
  }
  const narrow: FolderNarrowing = {};
  if (has('company_id') || has('companyId')) {
    narrow.company_id = (raw.company_id ?? raw.companyId) as number;
  }
  if (has('folder_type') || has('folderType')) {
    narrow.folder_type = String(raw.folder_type ?? raw.folderType);
  }
  if (has('id')) {
    const id = raw.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      throw new ValidationFailedError(`folders.resolve: { id } must be a positive integer, got "${String(id)}"`);
    }
    return { kind: 'id', id };
  }
  if (has('name')) {
    const name = raw.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationFailedError(`folders.resolve: { name } must be a non-empty string, got "${String(name)}"`);
    }
    return { kind: 'name', name, narrow };
  }
  throw new ValidationFailedError(
    `folders.resolve: unsupported identifier ${JSON.stringify(Object.keys(raw))}; accepted: ${ACCEPTED_KINDS}. ` +
      'The vendor filters /folders by name only, so a slug is not a supported kind here.',
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

export class FoldersResource extends BaseResource<Folder> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'folders', singleKey: 'folder', listKey: 'folders', createType: 'wrapped', paginated: true });
  }

  /** Get a folders by id. */
  async get(id: number): Promise<Folder> {
    return this.getOne<Folder>(id);
  }
  /** Stream folders across pages. */
  list(params?: FoldersListParams): AsyncIterable<Folder> {
    return this.items(params ?? {});
  }
  /** Get every folders. MCP-preferred read. */
  async listAll(params?: FoldersListParams): Promise<Folder[]> {
    return this.all(params ?? {});
  }
  /** Create a folder. `{ dryRun: true }` describes the write without issuing it. */
  async create(data: FolderCreate): Promise<Folder>;
  async create(data: FolderCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Folder>>;
  async create(data: FolderCreate, opts: MutationOptions & { dryRun?: false }): Promise<Folder>;
  async create(data: FolderCreate, opts: MutationOptions | undefined): Promise<Folder | DryRunResult<Folder>>;
  async create(data: FolderCreate, opts?: MutationOptions): Promise<Folder | DryRunResult<Folder>> {
    this.refuseGuardOnCreateOrDelete('folders.create', opts);
    if (opts?.dryRun) return this.createOne<Folder>({ folder: data }, undefined, { dryRun: true });
    return this.createOne<Folder>({ folder: data });
  }

  /** Update a folder. `{ dryRun: true }` describes the write; `{ expectedUpdatedAt }` guards it. */
  async update(id: number, data: FolderUpdate): Promise<Folder>;
  async update(id: number, data: FolderUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Folder>>;
  async update(id: number, data: FolderUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Folder>;
  async update(id: number, data: FolderUpdate, opts: MutationOptions | undefined): Promise<Folder | DryRunResult<Folder>>;
  async update(id: number, data: FolderUpdate, opts?: MutationOptions): Promise<Folder | DryRunResult<Folder>> {
    if (opts?.dryRun) return this.updateOne<Folder>(id, { folder: data }, undefined, { dryRun: true });
    if (opts?.expectedUpdatedAt !== undefined) {
      return this.updateOne<Folder>(id, { folder: data }, undefined, { expectedUpdatedAt: opts.expectedUpdatedAt });
    }
    return this.updateOne<Folder>(id, { folder: data });
  }

  /** Delete a folder. `{ dryRun: true }` describes the delete (plan `staleCheck: unavailable`). */
  async delete(id: number): Promise<void>;
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    this.refuseGuardOnCreateOrDelete('folders.delete', opts);
    if (opts?.dryRun) return this.deleteOne(id, { dryRun: true });
    return this.deleteOne(id);
  }

  listPages(params?: FoldersListParams): AsyncIterable<Page<Folder>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §6/§9). The vendor filters name, company_id and
  // folder_type, so a lookup never needs an unbounded account scan.
  // ---------------------------------------------------------------------------

  /**
   * Resolve one folder.
   *
   * Bare values are read in the documented order: numeric id, then exact name. Pass
   * `company_id` in the identifier to disambiguate the account-wide folder of the same
   * name, and `folder_type` to narrow to KB ('article') or photo folders. `{ id }` is a
   * direct fetch and a miss throws NOT_FOUND (never null); null means a COMPLETE scan
   * found nothing; a scan stopped by the client cap throws RESOLUTION_TRUNCATED;
   * several exact matches throw RESOLUTION_AMBIGUOUS.
   */
  async resolve(identifier: number | string | FolderIdentifier): Promise<FolderSummary | null>;
  async resolve(identifier: number | string | FolderIdentifier, opts: { expand: true }): Promise<Folder | null>;
  async resolve(identifier: number | string | FolderIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<FolderSummary>>;
  /** Both flags: the resolution of the FULL records. */
  async resolve(identifier: number | string | FolderIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<Folder>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(identifier: number | string | FolderIdentifier, opts: HelperOptions): Promise<Folder | FolderSummary | null | Resolution<FolderSummary> | Resolution<Folder>>;
  async resolve(
    identifier: number | string | FolderIdentifier,
    opts?: HelperOptions,
  ): Promise<Folder | FolderSummary | null | Resolution<FolderSummary> | Resolution<Folder>> {
    return formatResolution(await this.resolveRecord(identifier), toFolderSummary, opts);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Bounded, vendor-filtered scan that reports every exact match it examined. */
  private async scanExact(
    params: FoldersListParams,
    isExact: (item: Folder) => boolean,
  ): Promise<ExactScan<Folder>> {
    const matches: Folder[] = [];
    const resolution = await this.boundedScan<Folder>(this.pageFetcher(params), {
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
    scan: ExactScan<Folder>,
    operation: string,
    detail: string,
  ): Resolution<Folder> {
    const first = scan.matches[0];
    if (scan.matches.length > 1) {
      const ids = scan.matches.map((match) => match.id);
      throw ResolutionError.ambiguous(
        `${operation}: ${String(ids.length)} folders match ${detail}; pass company_id or an id from resourceIds to disambiguate.`,
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
  private async resolveRecord(identifier: number | string | FolderIdentifier): Promise<Resolution<Folder>> {
    const lookup = folderLookup(identifier);
    if (lookup.kind === 'id') {
      const record = await this.get(lookup.id);
      return { value: record, resolutionCost: 'direct', scanned: 0, scanTruncated: false };
    }
    if (lookup.kind === 'name') {
      return this.lookupByName(lookup.name, lookup.narrow);
    }
    // Bare value: numeric id first (handled above), then the exact name.
    return this.lookupByName(lookup.value, {});
  }

  /** One vendor-`name`-filtered lookup (the account-wide folder may repeat across companies). */
  private async lookupByName(
    name: string,
    narrow: FolderNarrowing,
  ): Promise<Resolution<Folder>> {
    const params: FoldersListParams = { name };
    if (narrow.company_id !== undefined && narrow.company_id !== null) params.company_id = narrow.company_id;
    if (narrow.folder_type !== undefined) params.folder_type = narrow.folder_type;
    const scan = await this.scanExact(params, (item) => item.name === name);
    return this.decideScan(scan, 'folders.resolve', `name "${name}"`);
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
