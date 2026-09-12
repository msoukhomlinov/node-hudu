/**
 * GroupsResource — Hudu "groups" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Group, GroupIdentifier, GroupSummary } from '../types/group.js';
import type { HelperOptions, Resolution } from '../types/common.js';
import { HuduConfigError, ResolutionError, ValidationFailedError } from '../errors.js';

export interface GroupsListParams extends ListParams {
  name?: string;
  default?: boolean;
  search?: string;
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
  matches: T[];
  scanned: number;
  scanTruncated: boolean;
}

/** The compact projection of a group record (`GroupSummary`). `members` is dropped. */
function toGroupSummary(record: Group): GroupSummary {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    default: record.default,
    member_count: record.member_count,
    updated_at: record.updated_at,
  };
}

/** The identifier kinds `groups.resolve` accepts (documented in the registry `usage`). */
const ACCEPTED_KINDS = 'a bare id/slug/name or an object with exactly one of { id }, { slug }, { name }';

/** A normalized lookup for `resolve`. */
type GroupLookup =
  | { kind: 'id'; id: number }
  | { kind: 'slug'; slug: string }
  | { kind: 'name'; name: string }
  | { kind: 'bare'; value: string };

/** Normalize the accepted identifier forms, refusing anything the vendor cannot support. */
function groupLookup(identifier: number | string | GroupIdentifier): GroupLookup {
  if (typeof identifier === 'number') {
    if (!Number.isInteger(identifier) || identifier < 1) {
      throw new ValidationFailedError(
        `groups.resolve: expected a positive integer id, got "${String(identifier)}"; accepted: ${ACCEPTED_KINDS}`,
      );
    }
    return { kind: 'id', id: identifier };
  }
  if (typeof identifier === 'string') {
    const text = identifier.trim();
    if (text.length === 0) {
      throw new ValidationFailedError(`groups.resolve: expected a non-empty identifier; accepted: ${ACCEPTED_KINDS}`);
    }
    return /^\d+$/.test(text) ? { kind: 'id', id: Number(text) } : { kind: 'bare', value: text };
  }
  const raw = identifier as Record<string, unknown>;
  const known = (['id', 'slug', 'name'] as const).filter((key) => raw[key] !== undefined && raw[key] !== null);
  if (known.length === 0) {
    throw new ValidationFailedError(
      `groups.resolve: unsupported identifier ${JSON.stringify(Object.keys(raw))}; accepted: ${ACCEPTED_KINDS}.`,
    );
  }
  if (known.length > 1) {
    throw new ValidationFailedError(
      `groups.resolve: pass exactly one of { id }, { slug }, { name }; got ${JSON.stringify(known)}`,
    );
  }
  const key = known[0] as 'id' | 'slug' | 'name';
  const value = raw[key];
  if (key === 'id') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new ValidationFailedError(`groups.resolve: { id } must be a positive integer, got "${String(value)}"`);
    }
    return { kind: 'id', id: value };
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationFailedError(`groups.resolve: { ${key} } must be a non-empty string, got "${String(value)}"`);
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

export class GroupsResource extends BaseResource<Group> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'groups', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /** Get a groups by id. */
  async get(id: number): Promise<Group> {
    return this.getOne<Group>(id);
  }
  /** Stream groups across pages. */
  list(params?: GroupsListParams): AsyncIterable<Group> {
    return this.items(params ?? {});
  }
  /** Get every groups. MCP-preferred read. */
  async listAll(params?: GroupsListParams): Promise<Group[]> {
    return this.all(params ?? {});
  }

  listPages(params?: GroupsListParams): AsyncIterable<Page<Group>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §6/§9). The vendor filters `name` and `search`; a slug
  // lookup narrows with `search` and compares the slug exactly.
  // ---------------------------------------------------------------------------

  /**
   * Resolve one group.
   *
   * Bare values are read in the documented order: numeric id, then slug, then exact
   * name. `{ id }` is a direct fetch and a miss throws NOT_FOUND (never null); null means
   * a COMPLETE scan found nothing; a scan stopped by the client cap throws
   * RESOLUTION_TRUNCATED; several exact matches throw RESOLUTION_AMBIGUOUS. The summary
   * carries `member_count` but never the member list.
   */
  async resolve(identifier: number | string | GroupIdentifier): Promise<GroupSummary | null>;
  async resolve(identifier: number | string | GroupIdentifier, opts: { expand: true }): Promise<Group | null>;
  async resolve(identifier: number | string | GroupIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<GroupSummary>>;
  /** Both flags: the resolution of the FULL records. */
  async resolve(identifier: number | string | GroupIdentifier, opts: { expand: true; resolutionDetails: true }): Promise<Resolution<Group>>;
  /** Options held in a variable: the caller must narrow the result. */
  async resolve(identifier: number | string | GroupIdentifier, opts: HelperOptions): Promise<Group | GroupSummary | null | Resolution<GroupSummary> | Resolution<Group>>;
  async resolve(
    identifier: number | string | GroupIdentifier,
    opts?: HelperOptions,
  ): Promise<Group | GroupSummary | null | Resolution<GroupSummary> | Resolution<Group>> {
    return formatResolution(await this.resolveRecord(identifier), toGroupSummary, opts);
  }

  /** Search groups by name (vendor `search` filter). `limit` defaults to 25, max 100. */
  async search(query: string): Promise<GroupSummary[]>;
  async search(query: string, opts: { expand: true; limit?: number }): Promise<Group[]>;
  async search(query: string, opts?: HelperOptions): Promise<Group[] | GroupSummary[]> {
    const limit = helperLimit(opts?.limit, 'groups.search');
    const page = await this.pageFetcher({ search: query })(1, limit);
    const items = page.items.slice(0, limit);
    return opts?.expand ? items : items.map(toGroupSummary);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Bounded, vendor-filtered scan that reports every exact match it examined. */
  private async scanExact(params: GroupsListParams, isExact: (item: Group) => boolean): Promise<ExactScan<Group>> {
    const matches: Group[] = [];
    const resolution = await this.boundedScan<Group>(this.pageFetcher(params), {
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
    scan: ExactScan<Group>,
    operation: string,
    detail: string,
  ): Resolution<Group> {
    const first = scan.matches[0];
    if (scan.matches.length > 1) {
      const ids = scan.matches.map((match) => match.id);
      throw ResolutionError.ambiguous(
        `${operation}: ${String(ids.length)} groups match ${detail}; choose one of the candidate ids in resourceIds.`,
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
  private async resolveRecord(identifier: number | string | GroupIdentifier): Promise<Resolution<Group>> {
    const lookup = groupLookup(identifier);
    if (lookup.kind === 'id') {
      const record = await this.get(lookup.id);
      return { value: record, resolutionCost: 'direct', scanned: 0, scanTruncated: false };
    }
    if (lookup.kind === 'slug') {
      // The vendor exposes no slug filter: narrow with `search`, then compare exactly.
      const scan = await this.scanExact({ search: lookup.slug }, (item) => item.slug === lookup.slug);
      return this.decideScan(scan, 'groups.resolve', `slug "${lookup.slug}"`);
    }
    if (lookup.kind === 'name') {
      const scan = await this.scanExact({ name: lookup.name }, (item) => item.name === lookup.name);
      return this.decideScan(scan, 'groups.resolve', `name "${lookup.name}"`);
    }
    // Bare value: numeric id first (handled above), then slug, then exact name.
    const slugScan = await this.scanExact({ search: lookup.value }, (item) => item.slug === lookup.value);
    const bySlug = this.decideScan(slugScan, 'groups.resolve', `slug "${lookup.value}"`);
    if (bySlug.value !== null) return bySlug;
    const nameScan = await this.scanExact({ name: lookup.value }, (item) => item.name === lookup.value);
    const byName = this.decideScan(nameScan, 'groups.resolve', `name "${lookup.value}"`);
    return { ...byName, scanned: slugScan.scanned + nameScan.scanned };
  }
}
