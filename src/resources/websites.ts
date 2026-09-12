/**
 * WebsitesResource — Hudu "websites" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Website, WebsiteCreate, WebsiteIdentifier, WebsiteSummary, WebsiteUpdate } from '../types/website.js';
import type {
  DryRunResult,
  HelperOptions,
  MutationOptions,
  Resolution,
} from '../types/common.js';
import { HuduConfigError, ResolutionError, ValidationFailedError } from '../errors.js';

export interface WebsitesListParams extends ListParams {
  name?: string;
  slug?: string;
  search?: string;
  updated_at?: string;
}

/** Rows a list-shaped helper returns when the caller does not say. */
const DEFAULT_LIMIT = 25;
/** Hard maximum rows a helper returns; above it the SDK refuses instead of clamping. */
const MAX_LIMIT = 100;

/** Validate a helper `limit` (default 25, hard max 100, never silently clamped). */
function helperLimit(limit: number | undefined, helper: string): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new HuduConfigError(
      `${helper}: limit must be an integer from 1 to ${MAX_LIMIT}, got "${String(limit)}"`,
    );
  }
  return limit;
}

/** One bounded, vendor-filtered scan for exact matches. */
interface ExactScan<T> {
  /** The exact matches examined — never more than enough to prove ambiguity. */
  matches: T[];
  /** Records examined. */
  scanned: number;
  /** True when a cap stopped the scan before the data ran out. */
  scanTruncated: boolean;
}

/** The compact projection of a website record (`WebsiteSummary`, declared in types/website.ts). */
function toWebsiteSummary(record: Website): WebsiteSummary {
  // EVERY field `WebsiteSummary` declares is populated from the record: a widening of
  // the interface must never leave the projection silently dropping a declared field.
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    company_id: record.company_id,
    company_name: record.company_name,
    status: record.status,
    monitoring_status: record.monitoring_status,
    paused: record.paused,
    archived: record.archived,
    url: record.url,
  };
}

/** The identifier kinds `websites.resolve` accepts (documented in the registry `usage`). */
const ACCEPTED_KINDS = 'a bare id/slug/name or an object with exactly one of { id }, { slug }, { name }';

/** A normalized lookup for `resolve`. */
type WebsiteLookup =
  | { kind: 'id'; id: number }
  | { kind: 'slug'; slug: string }
  | { kind: 'name'; name: string }
  | { kind: 'bare'; value: string };

/** Normalize the accepted identifier forms, refusing anything the vendor cannot support. */
function websiteLookup(identifier: number | string | WebsiteIdentifier): WebsiteLookup {
  if (typeof identifier === 'number') {
    if (!Number.isInteger(identifier) || identifier < 1) {
      throw new ValidationFailedError(
        `websites.resolve: expected a positive integer id, got "${String(identifier)}"; accepted: ${ACCEPTED_KINDS}`,
      );
    }
    return { kind: 'id', id: identifier };
  }
  if (typeof identifier === 'string') {
    const text = identifier.trim();
    if (text.length === 0) {
      throw new ValidationFailedError(
        `websites.resolve: expected a non-empty identifier; accepted: ${ACCEPTED_KINDS}`,
      );
    }
    return /^\d+$/.test(text) ? { kind: 'id', id: Number(text) } : { kind: 'bare', value: text };
  }
  const raw = identifier as Record<string, unknown>;
  const known = (['id', 'slug', 'name'] as const).filter((key) => raw[key] !== undefined && raw[key] !== null);
  if (known.length === 0) {
    throw new ValidationFailedError(
      `websites.resolve: unsupported identifier ${JSON.stringify(Object.keys(raw))}; accepted: ${ACCEPTED_KINDS}. ` +
        'The vendor filters /websites by name and slug only, so a domain is not a supported kind here.',
    );
  }
  if (known.length > 1) {
    throw new ValidationFailedError(
      `websites.resolve: pass exactly one of { id }, { slug }, { name }; got ${JSON.stringify(known)}`,
    );
  }
  const key = known[0] as 'id' | 'slug' | 'name';
  const value = raw[key];
  if (key === 'id') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new ValidationFailedError(
        `websites.resolve: { id } must be a positive integer, got "${String(value)}"`,
      );
    }
    return { kind: 'id', id: value };
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationFailedError(
      `websites.resolve: { ${key} } must be a non-empty string, got "${String(value)}"`,
    );
  }
  return key === 'slug' ? { kind: 'slug', slug: value } : { kind: 'name', name: value };
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

export class WebsitesResource extends BaseResource<Website> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'websites', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /** Get a websites by id. */
  async get(id: number): Promise<Website> {
    return this.getOne<Website>(id);
  }
  /** Stream websites across pages. */
  list(params?: WebsitesListParams): AsyncIterable<Website> {
    return this.items(params ?? {});
  }
  /** Get every websites. MCP-preferred read. */
  async listAll(params?: WebsitesListParams): Promise<Website[]> {
    return this.all(params ?? {});
  }
  /** Create a website. `{ dryRun: true }` describes the write without issuing it. */
  async create(data: WebsiteCreate): Promise<Website>;
  async create(data: WebsiteCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Website>>;
  async create(data: WebsiteCreate, opts: MutationOptions & { dryRun?: false }): Promise<Website>;
  async create(data: WebsiteCreate, opts: MutationOptions | undefined): Promise<Website | DryRunResult<Website>>;
  async create(data: WebsiteCreate, opts?: MutationOptions): Promise<Website | DryRunResult<Website>> {
    this.refuseGuardOnCreateOrDelete('websites.create', opts);
    if (opts?.dryRun) return this.createOne<Website>({ website: data }, undefined, { dryRun: true });
    return this.createOne<Website>({ website: data });
  }

  /** Update a website. `{ dryRun: true }` describes the write; `{ expectedUpdatedAt }` guards it. */
  async update(id: number, data: WebsiteUpdate): Promise<Website>;
  async update(id: number, data: WebsiteUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Website>>;
  async update(id: number, data: WebsiteUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Website>;
  async update(id: number, data: WebsiteUpdate, opts: MutationOptions | undefined): Promise<Website | DryRunResult<Website>>;
  async update(id: number, data: WebsiteUpdate, opts?: MutationOptions): Promise<Website | DryRunResult<Website>> {
    if (opts?.dryRun) return this.updateOne<Website>(id, { website: data }, undefined, { dryRun: true });
    if (opts?.expectedUpdatedAt !== undefined) {
      return this.updateOne<Website>(id, { website: data }, undefined, { expectedUpdatedAt: opts.expectedUpdatedAt });
    }
    return this.updateOne<Website>(id, { website: data });
  }

  /** Delete a website. `{ dryRun: true }` describes the delete (plan `staleCheck: unavailable`). */
  async delete(id: number): Promise<void>;
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    this.refuseGuardOnCreateOrDelete('websites.delete', opts);
    if (opts?.dryRun) return this.deleteOne(id, { dryRun: true });
    return this.deleteOne(id);
  }

  listPages(params?: WebsitesListParams): AsyncIterable<Page<Website>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §6/§9). `resolve` is the floor; the vendor filters name,
  // slug and search, so no helper needs an unbounded account scan.
  // ---------------------------------------------------------------------------

  /**
   * Resolve one website.
   *
   * Bare values are read in the documented order: numeric id, then slug, then exact
   * name. `{ id }` is a direct fetch and a miss throws NOT_FOUND (never null); null
   * means a COMPLETE scan found nothing; a scan stopped by the client cap throws
   * RESOLUTION_TRUNCATED; several exact matches throw RESOLUTION_AMBIGUOUS.
   */
  async resolve(identifier: number | string | WebsiteIdentifier): Promise<WebsiteSummary | null>;
  async resolve(identifier: number | string | WebsiteIdentifier, opts: { expand: true }): Promise<Website | null>;
  async resolve(identifier: number | string | WebsiteIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<WebsiteSummary>>;
  /** Both flags: the resolution of the FULL records. */
  async resolve(identifier: number | string | WebsiteIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<Website>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(identifier: number | string | WebsiteIdentifier, opts: HelperOptions): Promise<Website | WebsiteSummary | null | Resolution<WebsiteSummary> | Resolution<Website>>;
  async resolve(
    identifier: number | string | WebsiteIdentifier,
    opts?: HelperOptions,
  ): Promise<Website | WebsiteSummary | null | Resolution<WebsiteSummary> | Resolution<Website>> {
    return formatResolution(await this.resolveRecord(identifier), toWebsiteSummary, opts);
  }

  /** Find one website by its exact URL slug (vendor `slug` filter). */
  async findBySlug(slug: string): Promise<WebsiteSummary | null>;
  async findBySlug(slug: string, opts: { expand: true }): Promise<Website | null>;
  async findBySlug(slug: string, opts: { resolutionDetails: true }): Promise<Resolution<WebsiteSummary>>;
  /** Both flags: the resolution of the FULL records. */
  async findBySlug(slug: string, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<Website>>;
  async findBySlug(slug: string, opts: HelperOptions): Promise<Website | WebsiteSummary | null | Resolution<WebsiteSummary> | Resolution<Website>>;
  async findBySlug(
    slug: string,
    opts?: HelperOptions,
  ): Promise<Website | WebsiteSummary | null | Resolution<WebsiteSummary> | Resolution<Website>> {
    const scan = await this.scanExact({ slug }, (item) => item.slug === slug);
    const resolution = this.decideScan(scan, 'websites.findBySlug', `slug "${slug}"`);
    return formatResolution(resolution, toWebsiteSummary, opts);
  }

  /** Search monitored websites by free text (vendor `search` filter). `limit` defaults to 25, max 100. */
  async search(query: string): Promise<WebsiteSummary[]>;
  async search(query: string, opts: { expand: true; limit?: number }): Promise<Website[]>;
  async search(query: string, opts?: HelperOptions): Promise<Website[] | WebsiteSummary[]> {
    const limit = helperLimit(opts?.limit, 'websites.search');
    const page = await this.pageFetcher({ search: query })(1, limit);
    const items = page.items.slice(0, limit);
    return opts?.expand ? items : items.map(toWebsiteSummary);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Bounded, vendor-filtered scan that reports every exact match it examined. */
  private async scanExact(
    params: WebsitesListParams,
    isExact: (item: Website) => boolean,
  ): Promise<ExactScan<Website>> {
    const matches: Website[] = [];
    const resolution = await this.boundedScan<Website>(this.pageFetcher(params), {
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
    scan: ExactScan<Website>,
    operation: string,
    detail: string,
  ): Resolution<Website> {
    const first = scan.matches[0];
    if (scan.matches.length > 1) {
      const ids = scan.matches.map((match) => match.id);
      throw ResolutionError.ambiguous(
        `${operation}: ${String(ids.length)} websites match ${detail}; the vendor filter cannot disambiguate them.`,
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
  private async resolveRecord(identifier: number | string | WebsiteIdentifier): Promise<Resolution<Website>> {
    const lookup = websiteLookup(identifier);
    if (lookup.kind === 'id') {
      const record = await this.get(lookup.id);
      return { value: record, resolutionCost: 'direct', scanned: 0, scanTruncated: false };
    }
    if (lookup.kind === 'slug') {
      const scan = await this.scanExact({ slug: lookup.slug }, (item) => item.slug === lookup.slug);
      return this.decideScan(scan, 'websites.resolve', `slug "${lookup.slug}"`);
    }
    if (lookup.kind === 'name') {
      const scan = await this.scanExact({ name: lookup.name }, (item) => item.name === lookup.name);
      return this.decideScan(scan, 'websites.resolve', `name "${lookup.name}"`);
    }
    // Bare value: numeric id first (handled above), then slug, then exact name.
    const slugScan = await this.scanExact({ slug: lookup.value }, (item) => item.slug === lookup.value);
    const bySlug = this.decideScan(slugScan, 'websites.resolve', `slug "${lookup.value}"`);
    if (bySlug.value !== null) return bySlug;
    const nameScan = await this.scanExact({ name: lookup.value }, (item) => item.name === lookup.value);
    const byName = this.decideScan(nameScan, 'websites.resolve', `name "${lookup.value}"`);
    return { ...byName, scanned: slugScan.scanned + nameScan.scanned };
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
