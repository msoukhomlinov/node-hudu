/**
 * VlansResource — Hudu "vlans" resource.
 *
 * Agent-execution-layer helpers (policy §5-§6): `resolve` and `findByVlanId`, plus
 * `{ dryRun: true }` and the opt-in `{ expectedUpdatedAt }` guard on the mutating
 * primitives. Existing primitives keep their signatures and return types.
 *
 * `/vlans` is NOT paginated: one request returns the whole collection, and
 * `page`/`page_size` must never reach it (asserted by the tests).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Vlan, VlanCreate, VlanUpdate } from '../types/index.js';
import type { VlanIdentifier, VlanSummary } from '../types/vlan.js';
import type {
  DryRunResult,
  HelperOptions,
  MutationOptions,
  Resolution,
} from '../types/common.js';
import { NotFoundError, ResolutionError, ValidationFailedError } from '../errors.js';

export interface VlansListParams extends ListParams {
  company_id?: number;
  vlan_zone_id?: number;
  name?: string;
  vlan_id?: number;
  created_at?: string;
  updated_at?: string;
  archived?: boolean;
}

/** Identifier kinds `vlans.resolve` accepts; named in every rejection. */
const ACCEPTED_VLAN_KINDS = 'id, vlan_id, exact name';

/** Every VLAN lookup rejects an unsupported kind with the same structured error. */
function unsupportedVlanIdentifier(received: string): ValidationFailedError {
  return new ValidationFailedError(
    `vlans.resolve: unsupported identifier (${received}). Accepted identifier kinds: ${ACCEPTED_VLAN_KINDS}. ` +
      'Hudu declares no slug filter on /vlans, so a slug is not an accepted kind.',
    undefined,
    undefined,
    {
      operation: 'vlans.resolve',
      suggestedAction: `Pass one of: ${ACCEPTED_VLAN_KINDS}. An unsupported kind is rejected rather than guessed.`,
    },
  );
}

/** Candidate / log label for a VLAN. */
function vlanLabel(vlan: Vlan): string {
  return vlan.name || vlan.slug || String(vlan.vlan_id);
}

/** Compact projection: keeps the lookup fields, drops the bulky ones (policy §9). */
function toVlanSummary(vlan: Vlan): VlanSummary {
  return {
    id: vlan.id,
    name: vlan.name,
    slug: vlan.slug,
    vlan_id: vlan.vlan_id,
    company_id: vlan.company_id,
    vlan_zone_id: vlan.vlan_zone_id,
    status_list_item_id: vlan.status_list_item_id,
    role_list_item_id: vlan.role_list_item_id,
    networks_count: vlan.networks_count,
    url: vlan.url,
    updated_at: vlan.updated_at,
  };
}

export class VlansResource extends BaseResource<Vlan> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'vlans', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a vlans by id. */
  async get(id: number): Promise<Vlan> {
    return this.getOne<Vlan>(id);
  }
  /** Stream vlans across pages. */
  list(params?: VlansListParams): AsyncIterable<Vlan> {
    return this.items(params ?? {});
  }
  /** Get every vlans. MCP-preferred read. */
  async listAll(params?: VlansListParams): Promise<Vlan[]> {
    return this.all(params ?? {});
  }
  async create(data: VlanCreate): Promise<Vlan>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: VlanCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Vlan>>;
  async create(data: VlanCreate, opts: MutationOptions & { dryRun?: false }): Promise<Vlan>;
  async create(data: VlanCreate, opts: MutationOptions | undefined): Promise<Vlan | DryRunResult<Vlan>>;
  async create(data: VlanCreate, opts?: MutationOptions): Promise<Vlan | DryRunResult<Vlan>> {
    return this.createOne<Vlan>(data, undefined, opts);
  }
  async update(id: number, data: VlanUpdate): Promise<Vlan>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: VlanUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Vlan>>;
  /** Live update, optionally with the opt-in stale guard. */
  async update(id: number, data: VlanUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Vlan>;
  async update(id: number, data: VlanUpdate, opts: MutationOptions | undefined): Promise<Vlan | DryRunResult<Vlan>>;
  async update(id: number, data: VlanUpdate, opts?: MutationOptions): Promise<Vlan | DryRunResult<Vlan>> {
    return this.updateOne<Vlan>(id, data, undefined, opts);
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

  listPages(params?: VlansListParams): AsyncIterable<Page<Vlan>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve a VLAN from an id, a VLAN number or an exact name.
   *
   * Bare values follow the documented kind order: numeric id, vlan_id, exact name.
   * `{ id }` fetches directly and a miss throws NOT_FOUND (never `null`); `null` means
   * a complete scan found nothing. A capped scan throws RESOLUTION_TRUNCATED, and
   * several exact matches throw RESOLUTION_AMBIGUOUS with the candidate ids.
   */
  async resolve(identifier: number | string | VlanIdentifier): Promise<VlanSummary | null>;
  /** Full record instead of the compact summary. */
  async resolve(identifier: number | string | VlanIdentifier, opts: { expand: true }): Promise<Vlan | null>;
  /** `Resolution<VlanSummary>` (cost, scanned, scanTruncated, candidates). */
  async resolve(identifier: number | string | VlanIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<VlanSummary>>;
  /** `Resolution<Vlan>` with the full record. */
  async resolve(identifier: number | string | VlanIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<Vlan>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(
    identifier: number | string | VlanIdentifier,
    opts?: HelperOptions,
  ): Promise<Vlan | VlanSummary | null | Resolution<Vlan> | Resolution<VlanSummary>>;
  async resolve(
    identifier: number | string | VlanIdentifier,
    opts?: HelperOptions,
  ): Promise<Vlan | VlanSummary | null | Resolution<Vlan> | Resolution<VlanSummary>> {
    const resolution = await this.resolveRecord(identifier);
    if (opts?.resolutionDetails === true) {
      return opts.expand === true ? resolution : this.compactResolution(resolution);
    }
    if (resolution.value === null) return null;
    return opts?.expand === true ? resolution.value : toVlanSummary(resolution.value);
  }

  /**
   * Find one VLAN by its vendor VLAN number. Uses the vendor `vlan_id` filter with an
   * exact compare; several VLANs may reuse a number across zones, which is reported as
   * RESOLUTION_AMBIGUOUS rather than silently picking one.
   */
  async findByVlanId(vlanId: number): Promise<VlanSummary | null>;
  /** Full record instead of the compact summary. */
  async findByVlanId(vlanId: number, opts: { expand: true }): Promise<Vlan | null>;
  async findByVlanId(vlanId: number, opts?: { expand?: boolean }): Promise<Vlan | VlanSummary | null>;
  async findByVlanId(vlanId: number, opts?: { expand?: boolean }): Promise<Vlan | VlanSummary | null> {
    if (!Number.isInteger(vlanId)) throw unsupportedVlanIdentifier(String(vlanId));
    const scan = await this.exactScan({ vlan_id: vlanId }, (item) => item.vlan_id === vlanId);
    const resolution = this.decide(scan.matches, scan.scanned, scan.truncated, `vlan_id ${vlanId}`);
    if (resolution.value === null) return null;
    return opts?.expand === true ? resolution.value : toVlanSummary(resolution.value);
  }

  /** Turn a resolved full record into the compact `Resolution` projection. */
  private compactResolution(resolution: Resolution<Vlan>): Resolution<VlanSummary> {
    const compact: Resolution<VlanSummary> = {
      value: resolution.value === null ? null : toVlanSummary(resolution.value),
      resolutionCost: resolution.resolutionCost,
      scanned: resolution.scanned,
      scanTruncated: resolution.scanTruncated,
    };
    if (resolution.candidates !== undefined) compact.candidates = resolution.candidates;
    return compact;
  }

  /** Documented kind order for a bare value, narrowed per identifier kind. */
  private async resolveRecord(identifier: number | string | VlanIdentifier): Promise<Resolution<Vlan>> {
    if (typeof identifier === 'number') return this.resolveBareNumber(identifier);
    if (typeof identifier === 'string') {
      const value = identifier.trim();
      if (value.length === 0) throw unsupportedVlanIdentifier('an empty string');
      if (/^\d+$/.test(value)) return this.resolveBareNumber(Number(value));
      return this.resolveByFilter('name', value);
    }
    if (identifier !== null && typeof identifier === 'object' && !Array.isArray(identifier)) {
      const { id, vlan_id, name } = identifier;
      if (id !== undefined) return this.resolveById(id);
      if (vlan_id !== undefined) return this.resolveByFilter('vlan_id', vlan_id);
      if (typeof name === 'string') return this.resolveByFilter('name', name.trim());
      throw unsupportedVlanIdentifier(`an object with keys [${Object.keys(identifier).join(', ')}]`);
    }
    throw unsupportedVlanIdentifier(String(identifier));
  }

  /**
   * A BARE number is read in the documented order: id first, then the vendor `vlan_id`
   * filter. Only the `{ id }` form is a definite reference whose miss throws NOT_FOUND.
   */
  private async resolveBareNumber(value: number): Promise<Resolution<Vlan>> {
    try {
      return await this.resolveById(value);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      return this.resolveByFilter('vlan_id', value);
    }
  }

  /** Direct fetch. An id is a definite reference: a miss throws NOT_FOUND. */
  private async resolveById(id: number): Promise<Resolution<Vlan>> {
    if (!Number.isInteger(id) || id < 1) throw unsupportedVlanIdentifier(String(id));
    const record = await this.getOne<Vlan>(id);
    return {
      value: record,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: record.id, label: vlanLabel(record) }],
    };
  }

  /** Vendor-filter lookup (server narrows; the client compares exactly). */
  private async resolveByFilter(kind: 'name' | 'vlan_id', value: string | number): Promise<Resolution<Vlan>> {
    if (typeof value === 'string' && value.length === 0) throw unsupportedVlanIdentifier(`an empty ${kind}`);
    if (typeof value === 'number' && !Number.isInteger(value)) throw unsupportedVlanIdentifier(`${kind} ${value}`);
    const scan =
      kind === 'name'
        ? await this.exactScan({ name: String(value) }, (item) => item.name === value)
        : await this.exactScan({ vlan_id: Number(value) }, (item) => item.vlan_id === Number(value));
    return this.decide(scan.matches, scan.scanned, scan.truncated, `${kind} "${String(value)}"`);
  }

  /**
   * Bounded exact-match scan over the non-paginated collection (policy §6).
   *
   * The record cap is enforced by trimming the fetched page and reporting `hasMore`,
   * so a collection larger than the cap is reported as a truncated scan instead of a
   * false "no match". One HTTP request maximum; `page`/`page_size` never reach the wire.
   */
  private async exactScan(
    query: VlansListParams,
    predicate: (item: Vlan) => boolean,
  ): Promise<{ matches: Vlan[]; scanned: number; truncated: boolean }> {
    const cap = this.http.resolution.maxScanRecords;
    const fetcher = this.pageFetcher(query);
    const matches: Vlan[] = [];
    let examined = 0;
    const capped = async (page: number, pageSize: number): Promise<Page<Vlan>> => {
      const result = await fetcher(page, pageSize);
      const remaining = Math.max(cap - examined, 0);
      if (result.items.length > remaining) {
        examined += remaining;
        return { items: result.items.slice(0, remaining), page: result.page, page_size: result.page_size, hasMore: true };
      }
      examined += result.items.length;
      return result;
    };
    const resolution = await this.boundedScan<Vlan>(capped, {
      match: (item) => {
        if (predicate(item)) matches.push(item);
        return false;
      },
      label: vlanLabel,
      resolutionCost: 'server-filter',
      maxScanPages: 1,
      maxScanRecords: cap,
    });
    return { matches, scanned: resolution.scanned, truncated: resolution.scanTruncated };
  }

  /** Policy §6 decision: unique match, honest `null`, or a structured throw. */
  private decide(
    matches: Vlan[],
    scanned: number,
    truncated: boolean,
    descriptor: string,
  ): Resolution<Vlan> {
    if (truncated) {
      throw ResolutionError.truncated(
        `Client scan for vlans was truncated after ${scanned} record(s) while resolving ${descriptor}; ` +
          'a match may exist beyond the scan cap, so the lookup is undecided.',
        {
          operation: 'vlans.resolve',
          suggestedAction: 'Resolve by { id }, narrow the filter, or raise resolution.maxScanRecords/maxScanPages.',
        },
      );
    }
    const candidates = matches.map((match) => ({ id: match.id, label: vlanLabel(match) }));
    if (matches.length > 1) {
      throw ResolutionError.ambiguous(
        `Ambiguous vlans.resolve for ${descriptor}: ${matches.length} VLANs match exactly.`,
        { operation: 'vlans.resolve', resourceIds: candidates.map((candidate) => candidate.id) },
      );
    }
    const value = matches.length === 1 ? (matches[0] as Vlan) : null;
    const resolution: Resolution<Vlan> = {
      value,
      resolutionCost: 'server-filter',
      scanned,
      scanTruncated: false,
    };
    if (value !== null) resolution.candidates = candidates;
    return resolution;
  }
}
