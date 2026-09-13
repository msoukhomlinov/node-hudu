/**
 * RackStorageItemsResource — Hudu "rack_storage_items" resource.
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
import type {
  RackStorageItem,
  RackStorageItemCreate,
  RackStorageItemSummary,
  RackStorageItemUpdate,
} from '../types/rack_storage_item.js';

/**
 * Refuse `expectedUpdatedAt` on any mutation of this resource instead of silently pretending a guard
 * ran: `staleCheck` is "unavailable" here because the vendor's rack_storage_items record declares no
 * `updated_at` revision field, so a comparison could only produce a false STALE_OBJECT.
 */
function refuseExpectedUpdatedAt(method: string, opts: MutationOptions | undefined): void {
  if (opts?.expectedUpdatedAt === undefined) return;
  throw new HuduConfigError(
    `${method} takes no expectedUpdatedAt: rack_storage_items declares no updated_at revision field, so ` +
      'this resource records staleCheck "unavailable" and no guard exists. Re-read the item and re-issue ' +
      'the call, or bound the change by its explicit id.',
  );
}


export interface RackStorageItemsListParams extends ListParams {
  rack_storage_role_id?: number;
  asset_id?: number;
  start_unit?: number;
  end_unit?: number;
  status?: number;
  side?: string;
  created_at?: string;
  updated_at?: string;
}

/** Identifier kinds `rackStorageItems.resolve` accepts: the vendor names no rack storage item. */
const ACCEPTED_KINDS = 'a numeric id (a number, a numeric string, or { id: number })';

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

/**
 * Read the numeric id out of an identifier, or throw a structured validation error naming the
 * accepted kinds. The vendor API declares no name for a rack storage item, so there is no
 * name/asset identifier the SDK could honour — and it never guesses, and never scans.
 */
function rackStorageItemId(identifier: Identifier): number {
  if (typeof identifier === 'number') {
    if (Number.isInteger(identifier) && identifier > 0) return identifier;
  } else if (typeof identifier === 'string') {
    if (/^\d+$/.test(identifier)) return Number(identifier);
  } else if (typeof identifier === 'object' && identifier !== null) {
    const id = (identifier as IdentifierObject).id;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  }
  throw new HuduConfigError(
    `rack_storage_items.resolve accepts only ${ACCEPTED_KINDS}; got ${describeIdentifier(identifier)}. ` +
      'The Hudu API declares no name for a rack storage item: use rack_storage_items.listAll with ' +
      'asset_id or rack_storage_role_id to enumerate positions.',
  );
}

/** Compact projection (policy §9): drops max_wattage, power_draw, reserved_message and the role description/hex color. */
function toRackStorageItemSummary(item: RackStorageItem): RackStorageItemSummary {
  return {
    id: item.id,
    asset_id: item.asset_id,
    asset_name: item.asset_name,
    asset_url: item.asset_url,
    rack_storage_role_id: item.rack_storage_role_id,
    rack_storage_role_name: item.rack_storage_role_name,
    start_unit: item.start_unit,
    end_unit: item.end_unit,
    side: item.side,
    status: item.status,
    company_id: item.company_id,
    url: item.url,
  };
}

export class RackStorageItemsResource extends BaseResource<RackStorageItem> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'rack_storage_items', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a rack_storage_items by id. */
  async get(id: number): Promise<RackStorageItem> {
    return this.getOne<RackStorageItem>(id);
  }
  /** Stream rack_storage_items across pages. */
  list(params?: RackStorageItemsListParams): AsyncIterable<RackStorageItem> {
    return this.items(params ?? {});
  }
  /** Get every rack_storage_items. MCP-preferred read. */
  async listAll(params?: RackStorageItemsListParams): Promise<RackStorageItem[]> {
    return this.all(params ?? {});
  }

  /** Create a rack_storage_items record. */
  async create(data: RackStorageItemCreate): Promise<RackStorageItem>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: RackStorageItemCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<RackStorageItem>>;
  async create(data: RackStorageItemCreate, opts: MutationOptions & { dryRun?: false }): Promise<RackStorageItem>;
  async create(data: RackStorageItemCreate, opts: MutationOptions | undefined): Promise<RackStorageItem | DryRunResult<RackStorageItem>>;
  async create(data: RackStorageItemCreate, opts?: MutationOptions): Promise<RackStorageItem | DryRunResult<RackStorageItem>> {
    refuseExpectedUpdatedAt('rack_storage_items.create', opts);
    return this.createOne<RackStorageItem>({ rack_storage_item: data }, undefined, opts);
  }

  /** Update a rack_storage_items record (PUT response unwrapped by the resource's envelope key). */
  async update(id: number, data: RackStorageItemUpdate): Promise<RackStorageItem>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: RackStorageItemUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<RackStorageItem>>;
  async update(id: number, data: RackStorageItemUpdate, opts: MutationOptions & { dryRun?: false }): Promise<RackStorageItem>;
  async update(id: number, data: RackStorageItemUpdate, opts: MutationOptions | undefined): Promise<RackStorageItem | DryRunResult<RackStorageItem>>;
  async update(id: number, data: RackStorageItemUpdate, opts?: MutationOptions): Promise<RackStorageItem | DryRunResult<RackStorageItem>> {
    refuseExpectedUpdatedAt('rack_storage_items.update', opts);
    return this.updateOne<RackStorageItem>(id, { rack_storage_item: data }, undefined, opts);
  }

  /** Delete a rack_storage_items record. */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    refuseExpectedUpdatedAt('rack_storage_items.delete', opts);
    return this.deleteOne(id, opts);
  }

  listPages(params?: RackStorageItemsListParams): AsyncIterable<Page<RackStorageItem>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve a rack storage item from an identifier.
   *
   * Accepted kind: **a numeric id only** (policy §6). The vendor declares no name for a rack
   * storage item and no filter that identifies one record, so an id is fetched directly with
   * `GET /rack_storage_items/{id}` and any other identifier kind throws a structured validation
   * error naming the accepted kind — the helper never guesses and never scans.
   * An id miss throws `NOT_FOUND` (never `null`).
   *
   * Default return is {@link RackStorageItemSummary}; `{ expand: true }` returns the full
   * record, `{ resolutionDetails: true }` returns a `Resolution<RackStorageItemSummary>`.
   */
  async resolve(identifier: Identifier): Promise<RackStorageItemSummary | null>;
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<RackStorageItem | null>;
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<RackStorageItemSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: HelperOptions | ResolutionOptions,
  ): Promise<RackStorageItem | RackStorageItemSummary | Resolution<RackStorageItemSummary> | null>;
  async resolve(
    identifier: Identifier,
    opts?: HelperOptions | ResolutionOptions,
  ): Promise<RackStorageItem | RackStorageItemSummary | Resolution<RackStorageItemSummary> | null> {
    const id = rackStorageItemId(identifier);
    const record = await this.getByIdOrThrowMissing(id);
    if (opts?.resolutionDetails) {
      return {
        value: toRackStorageItemSummary(record),
        resolutionCost: 'direct',
        scanned: 1,
        scanTruncated: false,
      };
    }
    return opts?.expand === true ? record : toRackStorageItemSummary(record);
  }

  /**
   * Direct fetch whose 404 is re-labelled with this operation. The correlation id of the failed
   * request is preserved, and an id miss stays `NOT_FOUND` — never `null`.
   */
  private async getByIdOrThrowMissing(id: number): Promise<RackStorageItem> {
    try {
      return await this.getOne<RackStorageItem>(id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `rack_storage_items.resolve: no rack storage item with id ${id}`,
          err.url,
          err.body,
          { operation: 'rack_storage_items.resolve', resourceIds: [id], correlationId: err.correlationId },
        );
      }
      throw err;
    }
  }
}
