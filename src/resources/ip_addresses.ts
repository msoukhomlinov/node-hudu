/**
 * IpAddressesResource — Hudu "ip_addresses" resource.
 *
 * Agent-execution-layer helpers (policy §5-§6): `resolve` and `findByAddress`, plus
 * `{ dryRun: true }` on the mutating primitives. Existing primitives keep their
 * signatures and return types.
 *
 * `/ip_addresses` is NOT paginated: one request returns the whole collection, and
 * `page`/`page_size` must never reach it (asserted by the tests).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { IpAddress, IpAddressCreate, IpAddressUpdate } from '../types/index.js';
import type { IpAddressIdentifier, IpAddressSummary } from '../types/ip_address.js';
import type {
  DryRunResult,
  HelperOptions,
  MutationOptions,
  Resolution,
  ResolutionCandidate,
} from '../types/common.js';
import { ResolutionError, ValidationFailedError } from '../errors.js';

export interface IpAddressesListParams extends ListParams {
  network_id?: number;
  address?: string;
  status?: string;
  fqdn?: string;
  asset_id?: number;
  company_id?: number;
  created_at?: string;
  updated_at?: string;
}

/** Identifier kinds `ip_addresses.resolve` accepts; named in every rejection. */
const ACCEPTED_IP_KINDS = 'id, exact address, exact FQDN';

/** Every IP lookup rejects an unsupported kind with the same structured error. */
function unsupportedIpIdentifier(received: string): ValidationFailedError {
  return new ValidationFailedError(
    `ip_addresses.resolve: unsupported identifier (${received}). Accepted identifier kinds: ${ACCEPTED_IP_KINDS}.`,
    undefined,
    undefined,
    {
      operation: 'ip_addresses.resolve',
      suggestedAction: `Pass one of: ${ACCEPTED_IP_KINDS}. An unsupported kind is rejected rather than guessed.`,
    },
  );
}

/**
 * Candidate / log label for an IP address. The vendor's `IpAddress` definition
 * declares no `id`, so the label falls back to the address.
 */
function ipAddressLabel(record: IpAddress): string {
  return record.address || record.fqdn || 'ip_address';
}

/** Compact projection: keeps the lookup fields (including any id the vendor returned). */
function toIpAddressSummary(record: IpAddress): IpAddressSummary {
  return {
    id: record.id,
    address: record.address,
    status: record.status,
    fqdn: record.fqdn,
    asset_id: record.asset_id,
    network_id: record.network_id,
    company_id: record.company_id,
    description: record.description,
  };
}

export class IpAddressesResource extends BaseResource<IpAddress> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'ip_addresses', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a ip_addresses by id. */
  async get(id: number): Promise<IpAddress> {
    return this.getOne<IpAddress>(id);
  }
  /** Stream ip_addresses across pages. */
  list(params?: IpAddressesListParams): AsyncIterable<IpAddress> {
    return this.items(params ?? {});
  }
  /** Get every ip_addresses. MCP-preferred read. */
  async listAll(params?: IpAddressesListParams): Promise<IpAddress[]> {
    return this.all(params ?? {});
  }
  async create(data: IpAddressCreate): Promise<IpAddress>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: IpAddressCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<IpAddress>>;
  async create(data: IpAddressCreate, opts: MutationOptions & { dryRun?: false }): Promise<IpAddress>;
  async create(data: IpAddressCreate, opts: MutationOptions | undefined): Promise<IpAddress | DryRunResult<IpAddress>>;
  async create(data: IpAddressCreate, opts?: MutationOptions): Promise<IpAddress | DryRunResult<IpAddress>> {
    return this.createOne<IpAddress>(data, undefined, opts);
  }
  async update(id: number, data: IpAddressUpdate): Promise<IpAddress>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: IpAddressUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<IpAddress>>;
  async update(id: number, data: IpAddressUpdate, opts: MutationOptions & { dryRun?: false }): Promise<IpAddress>;
  async update(id: number, data: IpAddressUpdate, opts: MutationOptions | undefined): Promise<IpAddress | DryRunResult<IpAddress>>;
  async update(id: number, data: IpAddressUpdate, opts?: MutationOptions): Promise<IpAddress | DryRunResult<IpAddress>> {
    // registry staleCheck for this row is "unavailable": the vendor's IpAddress record
    // declares no `updated_at`, so `{ expectedUpdatedAt }` is accepted but NOT forwarded
    // (comparing against a revision that does not exist would fabricate a STALE_OBJECT).
    const forwarded: MutationOptions | undefined = opts === undefined ? undefined : { dryRun: opts.dryRun };
    return this.updateOne<IpAddress>(id, data, undefined, forwarded);
  }
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    // `staleCheck` is "unavailable" for this resource: the vendor's record does not
    // declare `updated_at`, so an `{ expectedUpdatedAt }` guard cannot be honoured.
    return this.deleteOne(id, opts);
  }

  listPages(params?: IpAddressesListParams): AsyncIterable<Page<IpAddress>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve an IP address record by id, exact address or exact FQDN.
   *
   * Bare values follow the documented kind order: numeric id, exact address, exact
   * FQDN. `{ id }` fetches directly and a miss throws NOT_FOUND (never `null`); `null`
   * means a complete scan found nothing. Candidate labels fall back to the address,
   * because the vendor's record definition declares no `id`.
   */
  async resolve(identifier: number | string | IpAddressIdentifier): Promise<IpAddressSummary | null>;
  /** Full record instead of the compact summary. */
  async resolve(identifier: number | string | IpAddressIdentifier, opts: { expand: true }): Promise<IpAddress | null>;
  /** `Resolution<IpAddressSummary>` (cost, scanned, scanTruncated, candidates). */
  async resolve(identifier: number | string | IpAddressIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<IpAddressSummary>>;
  /** `Resolution<IpAddress>` with the full record. */
  async resolve(identifier: number | string | IpAddressIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<IpAddress>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(
    identifier: number | string | IpAddressIdentifier,
    opts?: HelperOptions,
  ): Promise<IpAddress | IpAddressSummary | null | Resolution<IpAddress> | Resolution<IpAddressSummary>>;
  async resolve(
    identifier: number | string | IpAddressIdentifier,
    opts?: HelperOptions,
  ): Promise<IpAddress | IpAddressSummary | null | Resolution<IpAddress> | Resolution<IpAddressSummary>> {
    const resolution = await this.resolveRecord(identifier);
    if (opts?.resolutionDetails === true) {
      return opts.expand === true ? resolution : this.compactResolution(resolution);
    }
    if (resolution.value === null) return null;
    return opts?.expand === true ? resolution.value : toIpAddressSummary(resolution.value);
  }

  /**
   * Find one IP address record by its address. Uses the vendor `address` filter with an
   * exact client-side compare, so a partial server match is never returned.
   */
  async findByAddress(address: string): Promise<IpAddressSummary | null>;
  /** Full record instead of the compact summary. */
  async findByAddress(address: string, opts: { expand: true }): Promise<IpAddress | null>;
  async findByAddress(address: string, opts?: { expand?: boolean }): Promise<IpAddress | IpAddressSummary | null>;
  async findByAddress(address: string, opts?: { expand?: boolean }): Promise<IpAddress | IpAddressSummary | null> {
    const value = typeof address === 'string' ? address.trim() : '';
    if (value.length === 0) throw unsupportedIpIdentifier('an empty address');
    const resolution = await this.resolveByFilter('address', value);
    if (resolution.value === null) return null;
    return opts?.expand === true ? resolution.value : toIpAddressSummary(resolution.value);
  }

  /** Turn a resolved full record into the compact `Resolution` projection. */
  private compactResolution(resolution: Resolution<IpAddress>): Resolution<IpAddressSummary> {
    const compact: Resolution<IpAddressSummary> = {
      value: resolution.value === null ? null : toIpAddressSummary(resolution.value),
      resolutionCost: resolution.resolutionCost,
      scanned: resolution.scanned,
      scanTruncated: resolution.scanTruncated,
    };
    if (resolution.candidates !== undefined) compact.candidates = resolution.candidates;
    return compact;
  }

  /** Documented kind order for a bare value, narrowed per identifier kind. */
  private async resolveRecord(identifier: number | string | IpAddressIdentifier): Promise<Resolution<IpAddress>> {
    if (typeof identifier === 'number') return this.resolveById(identifier);
    if (typeof identifier === 'string') {
      const value = identifier.trim();
      if (value.length === 0) throw unsupportedIpIdentifier('an empty string');
      if (/^\d+$/.test(value)) return this.resolveById(Number(value));
      const byAddress = await this.resolveByFilter('address', value);
      if (byAddress.value !== null) return byAddress;
      const byFqdn = await this.resolveByFilter('fqdn', value);
      if (byFqdn.value !== null) return { ...byFqdn, scanned: byAddress.scanned + byFqdn.scanned };
      return {
        value: null,
        resolutionCost: byFqdn.resolutionCost,
        scanned: byAddress.scanned + byFqdn.scanned,
        scanTruncated: false,
      };
    }
    if (identifier !== null && typeof identifier === 'object' && !Array.isArray(identifier)) {
      const { id, address, fqdn } = identifier;
      if (id !== undefined) return this.resolveById(id);
      if (typeof address === 'string') return this.resolveByFilter('address', address.trim());
      if (typeof fqdn === 'string') return this.resolveByFilter('fqdn', fqdn.trim());
      throw unsupportedIpIdentifier(`an object with keys [${Object.keys(identifier).join(', ')}]`);
    }
    throw unsupportedIpIdentifier(String(identifier));
  }

  /** Direct fetch. An id is a definite reference: a miss throws NOT_FOUND. */
  private async resolveById(id: number): Promise<Resolution<IpAddress>> {
    if (!Number.isInteger(id) || id < 1) throw unsupportedIpIdentifier(String(id));
    const record = await this.getOne<IpAddress>(id);
    return {
      value: record,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: id, label: ipAddressLabel(record) }],
    };
  }

  /** Vendor-filter lookup (server narrows; the client compares exactly). */
  private async resolveByFilter(kind: 'address' | 'fqdn', value: string): Promise<Resolution<IpAddress>> {
    if (value.length === 0) throw unsupportedIpIdentifier(`an empty ${kind}`);
    const scan = await this.exactScan({ [kind]: value }, (item) => item[kind] === value);
    return this.decide(scan.matches, scan.scanned, scan.truncated, `${kind} "${value}"`);
  }

  /**
   * Bounded exact-match scan over the non-paginated collection (policy §6).
   *
   * The record cap is enforced by trimming the fetched page and reporting `hasMore`,
   * so a collection larger than the cap is reported as a truncated scan instead of a
   * false "no match". One HTTP request maximum; `page`/`page_size` never reach the wire.
   */
  private async exactScan(
    query: IpAddressesListParams,
    predicate: (item: IpAddress) => boolean,
  ): Promise<{ matches: IpAddress[]; scanned: number; truncated: boolean }> {
    const cap = this.http.resolution.maxScanRecords;
    const fetcher = this.pageFetcher(query);
    const matches: IpAddress[] = [];
    let examined = 0;
    const capped = async (page: number, pageSize: number): Promise<Page<IpAddress>> => {
      const result = await fetcher(page, pageSize);
      const remaining = Math.max(cap - examined, 0);
      if (result.items.length > remaining) {
        examined += remaining;
        return { items: result.items.slice(0, remaining), page: result.page, page_size: result.page_size, hasMore: true };
      }
      examined += result.items.length;
      return result;
    };
    const resolution = await this.boundedScan<IpAddress>(capped, {
      match: (item) => {
        if (predicate(item)) matches.push(item);
        return false;
      },
      label: ipAddressLabel,
      resolutionCost: 'server-filter',
      maxScanPages: 1,
      maxScanRecords: cap,
    });
    return { matches, scanned: resolution.scanned, truncated: resolution.scanTruncated };
  }

  /** Policy §6 decision: unique match, honest `null`, or a structured throw. */
  private decide(
    matches: IpAddress[],
    scanned: number,
    truncated: boolean,
    descriptor: string,
  ): Resolution<IpAddress> {
    if (truncated) {
      throw ResolutionError.truncated(
        `Client scan for ip_addresses was truncated after ${scanned} record(s) while resolving ${descriptor}; ` +
          'a match may exist beyond the scan cap, so the lookup is undecided.',
        {
          operation: 'ip_addresses.resolve',
          suggestedAction: 'Resolve by { id }, narrow the filter, or raise resolution.maxScanRecords/maxScanPages.',
        },
      );
    }
    // Only an id the vendor actually returned is listed as a candidate: the record
    // definition does not guarantee one, and a fabricated id would be a lie.
    const candidates: ResolutionCandidate[] = [];
    for (const match of matches) {
      if (typeof match.id === 'number') candidates.push({ id: match.id, label: ipAddressLabel(match) });
    }
    if (matches.length > 1) {
      throw ResolutionError.ambiguous(
        `Ambiguous ip_addresses.resolve for ${descriptor}: ${matches.length} IP addresses match exactly.`,
        {
          operation: 'ip_addresses.resolve',
          resourceIds: candidates.length > 0 ? candidates.map((candidate) => candidate.id) : undefined,
        },
      );
    }
    const value = matches.length === 1 ? (matches[0] as IpAddress) : null;
    const resolution: Resolution<IpAddress> = {
      value,
      resolutionCost: 'server-filter',
      scanned,
      scanTruncated: false,
    };
    if (value !== null && candidates.length > 0) resolution.candidates = candidates;
    return resolution;
  }
}
