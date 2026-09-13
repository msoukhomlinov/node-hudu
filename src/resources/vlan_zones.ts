/**
 * VlanZonesResource — Hudu "vlan_zones" resource.
 *
 * Agent-execution-layer helper (policy §5-§6): `resolve` by id, slug or exact name,
 * plus `{ dryRun: true }` and the opt-in `{ expectedUpdatedAt }` guard on the mutating
 * primitives. Existing primitives keep their signatures and return types.
 *
 * `/vlan_zones` is NOT paginated: one request returns the whole collection, and
 * `page`/`page_size` must never reach it (asserted by the tests).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { VlanZone, VlanZoneCreate, VlanZoneUpdate } from '../types/index.js';
import type { VlanZoneIdentifier, VlanZoneSummary } from '../types/vlan_zone.js';
import type {
  DryRunResult,
  HelperOptions,
  MutationOptions,
  Resolution,
  ResolutionCost,
} from '../types/common.js';
import { ResolutionError, ValidationFailedError } from '../errors.js';

export interface VlanZonesListParams extends ListParams {
  company_id?: number;
  name?: string;
  created_at?: string;
  updated_at?: string;
  archived?: boolean;
}

/** Identifier kinds `vlan_zones.resolve` accepts; named in every rejection. */
const ACCEPTED_ZONE_KINDS = 'id, slug, exact name';

/** Every zone lookup rejects an unsupported kind with the same structured error. */
function unsupportedZoneIdentifier(received: string): ValidationFailedError {
  return new ValidationFailedError(
    `vlan_zones.resolve: unsupported identifier (${received}). Accepted identifier kinds: ${ACCEPTED_ZONE_KINDS}.`,
    undefined,
    undefined,
    {
      operation: 'vlan_zones.resolve',
      suggestedAction: `Pass one of: ${ACCEPTED_ZONE_KINDS}. An unsupported kind is rejected rather than guessed.`,
    },
  );
}

/** Candidate / log label for a VLAN zone. */
function zoneLabel(zone: VlanZone): string {
  return zone.name || zone.slug || String(zone.id);
}

/** Compact projection: keeps the lookup fields, drops the bulky ones (policy §9). */
function toZoneSummary(zone: VlanZone): VlanZoneSummary {
  return {
    id: zone.id,
    name: zone.name,
    slug: zone.slug,
    vlan_id_ranges: zone.vlan_id_ranges,
    company_id: zone.company_id,
    vlans_count: zone.vlans_count,
    url: zone.url,
    updated_at: zone.updated_at,
  };
}

export class VlanZonesResource extends BaseResource<VlanZone> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'vlan_zones', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a vlan_zones by id. */
  async get(id: number): Promise<VlanZone> {
    return this.getOne<VlanZone>(id);
  }
  /** Stream vlan_zones across pages. */
  list(params?: VlanZonesListParams): AsyncIterable<VlanZone> {
    return this.items(params ?? {});
  }
  /** Get every vlan_zones. MCP-preferred read. */
  async listAll(params?: VlanZonesListParams): Promise<VlanZone[]> {
    return this.all(params ?? {});
  }
  async create(data: VlanZoneCreate): Promise<VlanZone>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: VlanZoneCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<VlanZone>>;
  async create(data: VlanZoneCreate, opts: MutationOptions & { dryRun?: false }): Promise<VlanZone>;
  async create(data: VlanZoneCreate, opts: MutationOptions | undefined): Promise<VlanZone | DryRunResult<VlanZone>>;
  async create(data: VlanZoneCreate, opts?: MutationOptions): Promise<VlanZone | DryRunResult<VlanZone>> {
    return this.createOne<VlanZone>(data, undefined, opts);
  }
  async update(id: number, data: VlanZoneUpdate): Promise<VlanZone>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: VlanZoneUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<VlanZone>>;
  /** Live update, optionally with the opt-in stale guard. */
  async update(id: number, data: VlanZoneUpdate, opts: MutationOptions & { dryRun?: false }): Promise<VlanZone>;
  async update(id: number, data: VlanZoneUpdate, opts: MutationOptions | undefined): Promise<VlanZone | DryRunResult<VlanZone>>;
  async update(id: number, data: VlanZoneUpdate, opts?: MutationOptions): Promise<VlanZone | DryRunResult<VlanZone>> {
    return this.updateOne<VlanZone>(id, data, undefined, opts);
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

  listPages(params?: VlanZonesListParams): AsyncIterable<Page<VlanZone>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve a VLAN zone by id, slug or exact name.
   *
   * Bare values follow the documented kind order: numeric id, slug, exact name. Hudu
   * declares no `slug` filter on `/vlan_zones`, so the slug kind is matched with one
   * complete read of the (non-paginated) collection and reports
   * `resolutionCost: 'client-scan'`; the name kind uses the vendor `name` filter.
   * `{ id }` fetches directly and a miss throws NOT_FOUND (never `null`).
   */
  async resolve(identifier: number | string | VlanZoneIdentifier): Promise<VlanZoneSummary | null>;
  /** Full record instead of the compact summary. */
  async resolve(identifier: number | string | VlanZoneIdentifier, opts: { expand: true }): Promise<VlanZone | null>;
  /** `Resolution<VlanZoneSummary>` (cost, scanned, scanTruncated, candidates). */
  async resolve(identifier: number | string | VlanZoneIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<VlanZoneSummary>>;
  /** `Resolution<VlanZone>` with the full record. */
  async resolve(identifier: number | string | VlanZoneIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<VlanZone>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(
    identifier: number | string | VlanZoneIdentifier,
    opts?: HelperOptions,
  ): Promise<VlanZone | VlanZoneSummary | null | Resolution<VlanZone> | Resolution<VlanZoneSummary>>;
  async resolve(
    identifier: number | string | VlanZoneIdentifier,
    opts?: HelperOptions,
  ): Promise<VlanZone | VlanZoneSummary | null | Resolution<VlanZone> | Resolution<VlanZoneSummary>> {
    const resolution = await this.resolveRecord(identifier);
    if (opts?.resolutionDetails === true) {
      return opts.expand === true ? resolution : this.compactResolution(resolution);
    }
    if (resolution.value === null) return null;
    return opts?.expand === true ? resolution.value : toZoneSummary(resolution.value);
  }

  /** Turn a resolved full record into the compact `Resolution` projection. */
  private compactResolution(resolution: Resolution<VlanZone>): Resolution<VlanZoneSummary> {
    const compact: Resolution<VlanZoneSummary> = {
      value: resolution.value === null ? null : toZoneSummary(resolution.value),
      resolutionCost: resolution.resolutionCost,
      scanned: resolution.scanned,
      scanTruncated: resolution.scanTruncated,
    };
    if (resolution.candidates !== undefined) compact.candidates = resolution.candidates;
    return compact;
  }

  /** Documented kind order for a bare value, narrowed per identifier kind. */
  private async resolveRecord(identifier: number | string | VlanZoneIdentifier): Promise<Resolution<VlanZone>> {
    if (typeof identifier === 'number') return this.resolveById(identifier);
    if (typeof identifier === 'string') {
      const value = identifier.trim();
      if (value.length === 0) throw unsupportedZoneIdentifier('an empty string');
      if (/^\d+$/.test(value)) return this.resolveById(Number(value));
      const bySlug = await this.resolveBySlug(value);
      if (bySlug.value !== null) return bySlug;
      const byName = await this.resolveByName(value);
      if (byName.value !== null) {
        return { ...byName, scanned: bySlug.scanned + byName.scanned };
      }
      return { value: null, resolutionCost: byName.resolutionCost, scanned: bySlug.scanned + byName.scanned, scanTruncated: false };
    }
    if (identifier !== null && typeof identifier === 'object' && !Array.isArray(identifier)) {
      const { id, slug, name } = identifier;
      if (id !== undefined) return this.resolveById(id);
      if (typeof slug === 'string') return this.resolveBySlug(slug.trim());
      if (typeof name === 'string') return this.resolveByName(name.trim());
      throw unsupportedZoneIdentifier(`an object with keys [${Object.keys(identifier).join(', ')}]`);
    }
    throw unsupportedZoneIdentifier(String(identifier));
  }

  /** Direct fetch. An id is a definite reference: a miss throws NOT_FOUND. */
  private async resolveById(id: number): Promise<Resolution<VlanZone>> {
    if (!Number.isInteger(id) || id < 1) throw unsupportedZoneIdentifier(String(id));
    const record = await this.getOne<VlanZone>(id);
    return {
      value: record,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: record.id, label: zoneLabel(record) }],
    };
  }

  /** Slug lookup: no vendor filter exists, so one complete collection read. */
  private async resolveBySlug(slug: string): Promise<Resolution<VlanZone>> {
    if (slug.length === 0) throw unsupportedZoneIdentifier('an empty slug');
    const scan = await this.exactScan({}, (item) => item.slug === slug, 'client-scan');
    return this.decide(scan.matches, scan.scanned, scan.truncated, 'client-scan', `slug "${slug}"`);
  }

  /** Name lookup through the vendor `name` filter (client-side exact compare). */
  private async resolveByName(name: string): Promise<Resolution<VlanZone>> {
    if (name.length === 0) throw unsupportedZoneIdentifier('an empty name');
    const scan = await this.exactScan({ name }, (item) => item.name === name, 'server-filter');
    return this.decide(scan.matches, scan.scanned, scan.truncated, 'server-filter', `name "${name}"`);
  }

  /**
   * Bounded exact-match scan over the non-paginated collection (policy §6).
   *
   * The record cap is enforced by trimming the fetched page and reporting `hasMore`,
   * so a collection larger than the cap is reported as a truncated scan instead of a
   * false "no match". One HTTP request maximum; `page`/`page_size` never reach the wire.
   */
  private async exactScan(
    query: VlanZonesListParams,
    predicate: (item: VlanZone) => boolean,
    cost: ResolutionCost,
  ): Promise<{ matches: VlanZone[]; scanned: number; truncated: boolean }> {
    const cap = this.http.resolution.maxScanRecords;
    const fetcher = this.pageFetcher(query);
    const matches: VlanZone[] = [];
    let examined = 0;
    const capped = async (page: number, pageSize: number): Promise<Page<VlanZone>> => {
      const result = await fetcher(page, pageSize);
      const remaining = Math.max(cap - examined, 0);
      if (result.items.length > remaining) {
        examined += remaining;
        return { items: result.items.slice(0, remaining), page: result.page, page_size: result.page_size, hasMore: true };
      }
      examined += result.items.length;
      return result;
    };
    const resolution = await this.boundedScan<VlanZone>(capped, {
      match: (item) => {
        if (predicate(item)) matches.push(item);
        return false;
      },
      label: zoneLabel,
      resolutionCost: cost,
      maxScanPages: 1,
      maxScanRecords: cap,
    });
    return { matches, scanned: resolution.scanned, truncated: resolution.scanTruncated };
  }

  /** Policy §6 decision: unique match, honest `null`, or a structured throw. */
  private decide(
    matches: VlanZone[],
    scanned: number,
    truncated: boolean,
    cost: ResolutionCost,
    descriptor: string,
  ): Resolution<VlanZone> {
    const candidates = matches.map((match) => ({ id: match.id, label: zoneLabel(match) }));
    if (matches.length > 1) {
      throw ResolutionError.ambiguous(
        `Ambiguous vlan_zones.resolve for ${descriptor}: ${matches.length} VLAN zones match exactly.`,
        { operation: 'vlan_zones.resolve', resourceIds: candidates.map((candidate) => candidate.id) },
      );
    }
    // A cap that stopped the scan is checked AFTER ambiguity: two or more exact matches
    // already decide the lookup, so RESOLUTION_AMBIGUOUS wins (policy §6).
    if (truncated) {
      throw ResolutionError.truncated(
        `Client scan for vlan_zones was truncated after ${scanned} record(s) while resolving ${descriptor}; ` +
          'a match may exist beyond the scan cap, so the lookup is undecided.',
        {
          operation: 'vlan_zones.resolve',
          suggestedAction: 'Resolve by { id }, narrow the filter, or raise resolution.maxScanRecords/maxScanPages.',
        },
      );
    }
    const value = matches.length === 1 ? (matches[0] as VlanZone) : null;
    const resolution: Resolution<VlanZone> = {
      value,
      resolutionCost: cost,
      scanned,
      scanTruncated: false,
    };
    if (value !== null) resolution.candidates = candidates;
    return resolution;
  }
}
