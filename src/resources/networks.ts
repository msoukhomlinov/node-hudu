/**
 * NetworksResource — Hudu "networks" resource.
 *
 * Agent-execution-layer helpers (policy §5-§6): `resolve` and `findByAddress`, plus
 * `{ dryRun: true }` and the opt-in `{ expectedUpdatedAt }` guard on the mutating
 * primitives. Existing primitives keep their signatures and return types.
 *
 * `/networks` is NOT paginated: one request returns the whole collection, and
 * `page`/`page_size` must never reach it (asserted by the tests).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Network, NetworkCreate, NetworkUpdate } from '../types/index.js';
import type { NetworkIdentifier, NetworkSummary } from '../types/network.js';
import type {
  DryRunResult,
  HelperOptions,
  MutationOptions,
  Resolution,
  ResolutionCost,
} from '../types/common.js';
import { ResolutionError, ValidationFailedError } from '../errors.js';

export interface NetworksListParams extends ListParams {
  company_id?: number;
  slug?: string;
  name?: string;
  network_type?: number;
  address?: string;
  location_id?: number;
  created_at?: string;
  updated_at?: string;
  archived?: boolean;
}

/** Identifier kinds `networks.resolve` accepts; named in every rejection. */
const ACCEPTED_NETWORK_KINDS = 'id, slug, name, address (CIDR)';

/** Every network lookup rejects an unsupported kind with the same structured error. */
function unsupportedNetworkIdentifier(received: string): ValidationFailedError {
  return new ValidationFailedError(
    `networks.resolve: unsupported identifier (${received}). Accepted identifier kinds: ${ACCEPTED_NETWORK_KINDS}.`,
    undefined,
    undefined,
    {
      operation: 'networks.resolve',
      suggestedAction: `Pass one of: ${ACCEPTED_NETWORK_KINDS}. An unsupported kind is rejected rather than guessed.`,
    },
  );
}

/** Candidate / log label for a network. `name` is the field callers resolve by. */
function networkLabel(network: Network): string {
  return network.name || network.slug || network.address || String(network.id);
}

/** Compact projection: keeps the lookup fields, drops the bulky ones (policy §9). */
function toNetworkSummary(network: Network): NetworkSummary {
  return {
    id: network.id,
    name: network.name,
    address: network.address,
    network_type: network.network_type,
    slug: network.slug,
    company_id: network.company_id,
    location_id: network.location_id,
    vlan_id: network.vlan_id,
    status_list_item_id: network.status_list_item_id,
    role_list_item_id: network.role_list_item_id,
    url: network.url,
    updated_at: network.updated_at,
  };
}

export class NetworksResource extends BaseResource<Network> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'networks', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a networks by id. */
  async get(id: number): Promise<Network> {
    return this.getOne<Network>(id);
  }
  /** Stream networks across pages. */
  list(params?: NetworksListParams): AsyncIterable<Network> {
    return this.items(params ?? {});
  }
  /** Get every networks. MCP-preferred read. */
  async listAll(params?: NetworksListParams): Promise<Network[]> {
    return this.all(params ?? {});
  }
  async create(data: NetworkCreate): Promise<Network>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: NetworkCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Network>>;
  async create(data: NetworkCreate, opts: MutationOptions & { dryRun?: false }): Promise<Network>;
  async create(data: NetworkCreate, opts: MutationOptions | undefined): Promise<Network | DryRunResult<Network>>;
  async create(data: NetworkCreate, opts?: MutationOptions): Promise<Network | DryRunResult<Network>> {
    return this.createOne<Network>(data, undefined, opts);
  }
  async update(id: number, data: NetworkUpdate): Promise<Network>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: NetworkUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Network>>;
  /** Live update, optionally with the opt-in stale guard. */
  async update(id: number, data: NetworkUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Network>;
  async update(id: number, data: NetworkUpdate, opts: MutationOptions | undefined): Promise<Network | DryRunResult<Network>>;
  async update(id: number, data: NetworkUpdate, opts?: MutationOptions): Promise<Network | DryRunResult<Network>> {
    return this.updateOne<Network>(id, data, undefined, opts);
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

  listPages(params?: NetworksListParams): AsyncIterable<Page<Network>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve a network by id, slug, exact name or address.
   *
   * Bare values follow the documented kind order: numeric id, slug, exact name,
   * address (CIDR). `{ id }` fetches directly and a miss throws NOT_FOUND (never
   * `null`); `null` means a complete scan found nothing. A scan that hit the record
   * cap throws RESOLUTION_TRUNCATED, and several exact matches throw
   * RESOLUTION_AMBIGUOUS with the candidate ids in `resourceIds`.
   */
  async resolve(identifier: number | string | NetworkIdentifier): Promise<NetworkSummary | null>;
  /** Full record instead of the compact summary. */
  async resolve(identifier: number | string | NetworkIdentifier, opts: { expand: true }): Promise<Network | null>;
  /** `Resolution<NetworkSummary>` (cost, scanned, scanTruncated, candidates). */
  async resolve(identifier: number | string | NetworkIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<NetworkSummary>>;
  /** `Resolution<Network>` with the full record. */
  async resolve(identifier: number | string | NetworkIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<Network>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(
    identifier: number | string | NetworkIdentifier,
    opts?: HelperOptions,
  ): Promise<Network | NetworkSummary | null | Resolution<Network> | Resolution<NetworkSummary>>;
  async resolve(
    identifier: number | string | NetworkIdentifier,
    opts?: HelperOptions,
  ): Promise<Network | NetworkSummary | null | Resolution<Network> | Resolution<NetworkSummary>> {
    const resolution = await this.resolveRecord(identifier);
    if (opts?.resolutionDetails === true) {
      return opts.expand === true ? resolution : this.compactResolution(resolution);
    }
    if (resolution.value === null) return null;
    return opts?.expand === true ? resolution.value : toNetworkSummary(resolution.value);
  }

  /**
   * Find one network by its CIDR address. Uses the vendor `address` filter with an
   * exact client-side compare, so a partial server match is never returned.
   */
  async findByAddress(address: string): Promise<NetworkSummary | null>;
  /** Full record instead of the compact summary. */
  async findByAddress(address: string, opts: { expand: true }): Promise<Network | null>;
  async findByAddress(address: string, opts?: { expand?: boolean }): Promise<Network | NetworkSummary | null>;
  async findByAddress(address: string, opts?: { expand?: boolean }): Promise<Network | NetworkSummary | null> {
    const value = typeof address === 'string' ? address.trim() : '';
    if (value.length === 0) throw unsupportedNetworkIdentifier('an empty address');
    const resolution = await this.resolveByFilter('address', value);
    if (resolution.value === null) return null;
    return opts?.expand === true ? resolution.value : toNetworkSummary(resolution.value);
  }

  /** Turn a resolved full record into the compact `Resolution` projection. */
  private compactResolution(resolution: Resolution<Network>): Resolution<NetworkSummary> {
    const compact: Resolution<NetworkSummary> = {
      value: resolution.value === null ? null : toNetworkSummary(resolution.value),
      resolutionCost: resolution.resolutionCost,
      scanned: resolution.scanned,
      scanTruncated: resolution.scanTruncated,
    };
    if (resolution.candidates !== undefined) compact.candidates = resolution.candidates;
    return compact;
  }

  /** Documented kind order for a bare value, narrowed per identifier kind. */
  private async resolveRecord(identifier: number | string | NetworkIdentifier): Promise<Resolution<Network>> {
    if (typeof identifier === 'number') return this.resolveById(identifier);
    if (typeof identifier === 'string') {
      const value = identifier.trim();
      if (value.length === 0) throw unsupportedNetworkIdentifier('an empty string');
      if (/^\d+$/.test(value)) return this.resolveById(Number(value));
      let scanned = 0;
      let cost: ResolutionCost = 'server-filter';
      for (const kind of ['slug', 'name', 'address'] as const) {
        const attempt = await this.resolveByFilter(kind, value);
        scanned += attempt.scanned;
        cost = attempt.resolutionCost;
        if (attempt.value !== null) return { ...attempt, scanned };
      }
      return { value: null, resolutionCost: cost, scanned, scanTruncated: false };
    }
    if (identifier !== null && typeof identifier === 'object' && !Array.isArray(identifier)) {
      const { id, address, slug, name } = identifier;
      if (id !== undefined) return this.resolveById(id);
      if (typeof address === 'string') return this.resolveByFilter('address', address.trim());
      if (typeof slug === 'string') return this.resolveByFilter('slug', slug.trim());
      if (typeof name === 'string') return this.resolveByFilter('name', name.trim());
      throw unsupportedNetworkIdentifier(`an object with keys [${Object.keys(identifier).join(', ')}]`);
    }
    throw unsupportedNetworkIdentifier(String(identifier));
  }

  /** Direct fetch. An id is a definite reference: a miss throws NOT_FOUND. */
  private async resolveById(id: number): Promise<Resolution<Network>> {
    if (!Number.isInteger(id) || id < 1) throw unsupportedNetworkIdentifier(String(id));
    const record = await this.getOne<Network>(id);
    return {
      value: record,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: record.id, label: networkLabel(record) }],
    };
  }

  /** Vendor-filter lookup (server narrows; the client compares exactly). */
  private async resolveByFilter(
    kind: 'slug' | 'name' | 'address',
    value: string,
  ): Promise<Resolution<Network>> {
    if (value.length === 0) throw unsupportedNetworkIdentifier(`an empty ${kind}`);
    const scan = await this.exactScan({ [kind]: value }, (item) => item[kind] === value);
    return this.decide(scan.matches, scan.scanned, scan.truncated, 'server-filter', `${kind} "${value}"`);
  }

  /**
   * Bounded exact-match scan over the non-paginated collection (policy §6).
   *
   * The record cap is enforced by trimming the fetched page and reporting `hasMore`,
   * so a collection larger than the cap is reported as a truncated scan instead of a
   * false "no match". One HTTP request maximum; `page`/`page_size` never reach the wire.
   */
  private async exactScan(
    query: NetworksListParams,
    predicate: (item: Network) => boolean,
  ): Promise<{ matches: Network[]; scanned: number; truncated: boolean }> {
    const cap = this.http.resolution.maxScanRecords;
    const fetcher = this.pageFetcher(query);
    const matches: Network[] = [];
    let examined = 0;
    const capped = async (page: number, pageSize: number): Promise<Page<Network>> => {
      const result = await fetcher(page, pageSize);
      const remaining = Math.max(cap - examined, 0);
      if (result.items.length > remaining) {
        examined += remaining;
        return { items: result.items.slice(0, remaining), page: result.page, page_size: result.page_size, hasMore: true };
      }
      examined += result.items.length;
      return result;
    };
    const resolution = await this.boundedScan<Network>(capped, {
      match: (item) => {
        if (predicate(item)) matches.push(item);
        return false;
      },
      label: networkLabel,
      resolutionCost: 'server-filter',
      maxScanPages: 1,
      maxScanRecords: cap,
    });
    return { matches, scanned: resolution.scanned, truncated: resolution.scanTruncated };
  }

  /** Policy §6 decision: unique match, honest `null`, or a structured throw. */
  private decide(
    matches: Network[],
    scanned: number,
    truncated: boolean,
    cost: ResolutionCost,
    descriptor: string,
  ): Resolution<Network> {
    const candidates = matches.map((match) => ({ id: match.id, label: networkLabel(match) }));
    if (matches.length > 1) {
      throw ResolutionError.ambiguous(
        `Ambiguous networks.resolve for ${descriptor}: ${matches.length} networks match exactly.`,
        { operation: 'networks.resolve', resourceIds: candidates.map((candidate) => candidate.id) },
      );
    }
    // A cap that stopped the scan is checked AFTER ambiguity: two or more exact matches
    // already decide the lookup, so RESOLUTION_AMBIGUOUS wins (policy §6).
    if (truncated) {
      throw ResolutionError.truncated(
        `Client scan for networks was truncated after ${scanned} record(s) while resolving ${descriptor}; ` +
          'a match may exist beyond the scan cap, so the lookup is undecided.',
        {
          operation: 'networks.resolve',
          suggestedAction: 'Resolve by { id }, narrow the filter, or raise resolution.maxScanRecords/maxScanPages.',
        },
      );
    }
    const value = matches.length === 1 ? (matches[0] as Network) : null;
    const resolution: Resolution<Network> = {
      value,
      resolutionCost: cost,
      scanned,
      scanTruncated: false,
    };
    if (value !== null) resolution.candidates = candidates;
    return resolution;
  }
}
