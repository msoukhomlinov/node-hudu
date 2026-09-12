/**
 * AssetLayoutsResource — Hudu "asset_layouts" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { AssetLayout, AssetLayoutCreate, AssetLayoutUpdate } from '../types/index.js';
import type { AssetLayoutIdentifier, AssetLayoutSummary } from '../types/asset_layout.js';
import type { DryRunResult, HelperOptions, MutationOptions, Resolution, ResolutionCandidate } from '../types/common.js';
import { HuduConfigError, ResolutionError } from '../errors.js';
import { DEFAULT_PAGE_SIZE } from '../config.js';

/** Upper bound on server-side pages walked before refusing (runaway guard). */
const MAX_PAGES = 100_000;

/**
 * Options of `asset_layouts.create`. A create has no prior revision, so there is no
 * `expectedUpdatedAt` guard: the option is deliberately absent from this signature
 * rather than declared and ignored.
 */
export interface LayoutWriteOptions {
  dryRun?: boolean;
}

/** Helper `limit` bounds (policy §9): default 25, hard maximum 100. */
const MAX_HELPER_LIMIT = 100;

/** The identifier kinds `asset_layouts.resolve` documents. */
const LAYOUT_IDENTIFIER_KINDS =
  'asset_layouts.resolve accepts { id }, { name } or { slug }, or a bare numeric id / slug / exact name';

/** Validate a helper `limit`: default 25, hard maximum 100 — never silently clamped. */
function helperLimit(limit: number | undefined): number {
  if (limit === undefined) return 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HELPER_LIMIT) {
    throw new HuduConfigError(`limit must be an integer from 1 to ${MAX_HELPER_LIMIT}, got "${String(limit)}"`);
  }
  return limit;
}

/** Case-insensitive, whitespace-trimmed equality — the exact compare applied to a vendor filter. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Ambiguity label for one layout. */
function layoutLabel(layout: AssetLayout): string {
  return `${layout.name} (slug ${layout.slug}, id ${layout.id})`;
}

/** Compact projection of a full asset layout record (policy §9). */
export function toAssetLayoutSummary(layout: AssetLayout): AssetLayoutSummary {
  return {
    id: layout.id,
    name: layout.name,
    slug: layout.slug,
    active: layout.active,
    icon: layout.icon,
    color: layout.color,
  };
}

/**
 * Apply the caller's requested shape to a resolution: compact by default,
 * `expand: true` for the full record, `resolutionDetails: true` for the
 * `Resolution<T>` wrapper (cost, scanned, scanTruncated, candidates).
 */
function projectResolution<U, S>(
  resolution: Resolution<U>,
  opts: HelperOptions | undefined,
  summarize: (item: U) => S,
): unknown {
  if (opts?.resolutionDetails === true) {
    if (resolution.value === null) return { ...resolution, value: null } as Resolution<S>;
    const value = (opts.expand === true ? resolution.value : summarize(resolution.value)) as S;
    return { ...resolution, value } as Resolution<S>;
  }
  if (resolution.value === null) return null;
  return opts?.expand === true ? resolution.value : summarize(resolution.value);
}

export interface AssetLayoutsListParams extends ListParams {
  name?: string;
  slug?: string;
  active?: boolean;
  updated_at?: string;
}

export class AssetLayoutsResource extends BaseResource<AssetLayout> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'asset_layouts', singleKey: 'asset_layout', listKey: 'asset_layouts', createType: 'wrapped', paginated: true });
  }

  /** Get a asset_layouts by id. */
  async get(id: number): Promise<AssetLayout> {
    return this.getOne<AssetLayout>(id);
  }
  /** Stream asset_layouts across pages. */
  list(params?: AssetLayoutsListParams): AsyncIterable<AssetLayout> {
    return this.assetLayoutItems(params ?? {});
  }
  /** Get every asset_layouts. MCP-preferred read. */
  async listAll(params?: AssetLayoutsListParams): Promise<AssetLayout[]> {
    const all: AssetLayout[] = [];
    for await (const page of this.assetLayoutPages(params ?? {})) all.push(...page.items);
    return all;
  }

  async create(data: AssetLayoutCreate): Promise<AssetLayout>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: AssetLayoutCreate, opts: { dryRun: true }): Promise<DryRunResult<AssetLayout>>;
  async create(data: AssetLayoutCreate, opts?: LayoutWriteOptions): Promise<AssetLayout | DryRunResult<AssetLayout>>;
  /**
   * POST /asset_layouts. `{ dryRun: true }` describes the create without issuing
   * it. A create has no prior revision, so there is no `expectedUpdatedAt` guard and
   * the option is not part of this signature.
   */
  async create(data: AssetLayoutCreate, opts?: LayoutWriteOptions): Promise<AssetLayout | DryRunResult<AssetLayout>> {
    return this.createOne<AssetLayout>(data, undefined, opts);
  }

  async update(id: number, data: AssetLayoutUpdate): Promise<AssetLayout>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: AssetLayoutUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<AssetLayout>>;
  /** Live update, optionally with the opt-in `expectedUpdatedAt` stale guard. */
  async update(id: number, data: AssetLayoutUpdate, opts: MutationOptions & { dryRun?: false }): Promise<AssetLayout>;
  async update(id: number, data: AssetLayoutUpdate, opts?: MutationOptions): Promise<AssetLayout | DryRunResult<AssetLayout>>;
  async update(id: number, data: AssetLayoutUpdate, opts?: MutationOptions): Promise<AssetLayout | DryRunResult<AssetLayout>> {
    return this.updateOne<AssetLayout>(id, data, undefined, opts);
  }

  listPages(params?: AssetLayoutsListParams): AsyncIterable<Page<AssetLayout>> {
    return this.assetLayoutPages(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Agent-execution-layer helpers (policy §5-§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve a layout from an id, name or slug (policy §6). A bare value is read in
   * the documented order: numeric id, slug, exact name. `{ id }` (or a numeric bare
   * value) is a direct fetch: a miss throws `NOT_FOUND`, never `null`. Layouts are a
   * small configuration table, so the resolution caps are never expected to be
   * reached; a capped scan would throw `RESOLUTION_TRUNCATED` rather than return
   * `null`.
   *
   * `limit` is validated against the helper bounds (default 25, hard maximum 100)
   * but cannot be applied to the request: GET /asset_layouts accepts `page` and not
   * `page_size`, so a layout read is one server-sized page.
   */
  async resolve(identifier: number | string | AssetLayoutIdentifier): Promise<AssetLayoutSummary | null>;
  /** `expand: true` returns the full record. */
  async resolve(identifier: number | string | AssetLayoutIdentifier, opts: HelperOptions & { expand: true }): Promise<AssetLayout | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async resolve(identifier: number | string | AssetLayoutIdentifier, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<AssetLayoutSummary>>;
  async resolve(
    identifier: number | string | AssetLayoutIdentifier,
    opts?: HelperOptions,
  ): Promise<AssetLayoutSummary | AssetLayout | null | Resolution<AssetLayoutSummary>>;
  async resolve(
    identifier: number | string | AssetLayoutIdentifier,
    opts?: HelperOptions,
  ): Promise<AssetLayoutSummary | AssetLayout | null | Resolution<AssetLayoutSummary>> {
    const resolution = await this.resolveRecord(identifier, opts);
    return projectResolution(resolution, opts, toAssetLayoutSummary) as
      | AssetLayoutSummary
      | AssetLayout
      | null
      | Resolution<AssetLayoutSummary>;
  }

  /** The identifier -> resolution table of `resolve` (policy §6). */
  private async resolveRecord(
    identifier: number | string | AssetLayoutIdentifier,
    opts?: HelperOptions,
  ): Promise<Resolution<AssetLayout>> {
    if (typeof identifier === 'number') return this.byId(identifier);
    if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (text.length === 0) throw new HuduConfigError(LAYOUT_IDENTIFIER_KINDS);
      if (/^\d+$/.test(text)) return this.byId(Number(text));
      const bySlug = await this.filterScan({ slug: text }, (layout) => sameText(layout.slug, text), opts);
      if (bySlug.value !== null) return bySlug;
      return this.filterScan({ name: text }, (layout) => sameText(layout.name, text), opts);
    }
    if (identifier === null || typeof identifier !== 'object') throw new HuduConfigError(LAYOUT_IDENTIFIER_KINDS);
    if (typeof identifier.id === 'number') return this.byId(identifier.id);
    if (typeof identifier.slug === 'string') {
      return this.filterScan({ slug: identifier.slug }, (layout) => sameText(layout.slug, identifier.slug), opts);
    }
    if (typeof identifier.name === 'string') {
      return this.filterScan({ name: identifier.name }, (layout) => sameText(layout.name, identifier.name), opts);
    }
    throw new HuduConfigError(LAYOUT_IDENTIFIER_KINDS);
  }

  /** Direct fetch by id: a miss throws NOT_FOUND (never null). */
  private async byId(id: number): Promise<Resolution<AssetLayout>> {
    const layout = await this.get(id);
    return {
      value: layout,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: layout.id, label: layoutLabel(layout) } satisfies ResolutionCandidate],
    };
  }

  /**
   * One bounded, server-filtered scan (policy §6): the vendor filter narrows the
   * result set, the exact compare decides. Several matches throw
   * `RESOLUTION_AMBIGUOUS`; a complete scan with no match is `null`; a scan the client
   * cap stopped throws `RESOLUTION_TRUNCATED` — never `null`.
   *
   * GET /asset_layouts accepts `page` but NOT `page_size` (api-docs 2.45.1), so the
   * server's page size cannot be requested: the walk assumes the SDK's documented
   * default page size and grows it when the server returns a longer page; a page
   * shorter than the known full page (or empty) is the last page. Walking pages is
   * what makes a layout that sits on page 2+ resolvable instead of reported as
   * "not found".
   */
  private async filterScan(
    filter: Record<string, unknown>,
    matches: (layout: AssetLayout) => boolean,
    opts?: HelperOptions,
  ): Promise<Resolution<AssetLayout>> {
    helperLimit(opts?.limit);
    const operation = 'asset_layouts.resolve';
    const fetched: AssetLayout[] = [];
    let fullPage = DEFAULT_PAGE_SIZE;
    const scan = await this.boundedScan<AssetLayout>(
      async (page) => {
        const body = await this.request<unknown>({
          method: 'GET',
          path: `/${this.resourcePath}`,
          query: { ...filter, page },
          operation,
        });
        const items = this.unwrapList<AssetLayout>(body);
        // `page_size` is not in the spec, so the full-page size is learned from the
        // responses themselves and never sent (mirrors assetLayoutPages).
        if (items.length > fullPage) fullPage = items.length;
        return { items, page, page_size: fullPage, hasMore: items.length > 0 && items.length === fullPage };
      },
      {
        match: (layout) => {
          fetched.push(layout);
          return false;
        },
        label: layoutLabel,
        resolutionCost: 'server-filter',
      },
    );
    const exact = fetched.filter(matches);
    if (exact.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: ${exact.length} asset layouts match the identifier exactly, so it is not unique.`,
        { operation, resourceIds: exact.map((layout) => layout.id) },
      );
    }
    const only = exact.length === 1 ? (exact[0] as AssetLayout) : undefined;
    if (only !== undefined) {
      return {
        value: only,
        resolutionCost: 'server-filter',
        scanned: fetched.length,
        scanTruncated: false,
        candidates: [{ id: only.id, label: layoutLabel(only) } satisfies ResolutionCandidate],
      };
    }
    if (scan.scanTruncated) {
      // The cap stopped the walk before the data ran out, so "not found" cannot be
      // decided: returning null here would be a lie.
      throw ResolutionError.truncated(
        `${operation}: the bounded client scan was truncated after ${String(fetched.length)} record(s), ` +
          'so no exact match could be decided.',
        { operation },
      );
    }
    if (fetched.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: the vendor filter is inexact and returned ${fetched.length} asset layouts, none matching exactly.`,
        { operation, resourceIds: fetched.map((layout) => layout.id) },
      );
    }
    return { value: null, resolutionCost: 'server-filter', scanned: fetched.length, scanTruncated: false };
  }

  /**
   * Walk /asset_layouts across pages.
   *
   * GET /asset_layouts accepts name | page | slug | active | updated_at — but
   * NOT page_size, so the server paginates at its own internal page size, which
   * the SDK cannot set and does not know in advance. Termination is therefore
   * driven by what the server actually returns, never by the SDK's default
   * page_size (25) that is never sent — otherwise results would be silently
   * truncated after page 1 (or an extra empty request issued) whenever the
   * server's page size differs from 25 (R1).
   *
   * The largest non-empty page seen is taken as the server's full-page size and
   * drives `hasMore`; a page shorter than a known full page (or empty) is last.
   */
  private async *assetLayoutPages(params: AssetLayoutsListParams): AsyncGenerator<Page<AssetLayout>> {
    const query: Record<string, unknown> = { ...params };
    // Non-integer (1.5) and non-positive (0/-N) `page` are invalid, symmetric
    // with BaseResource.paginationOpts (F8).
    if (typeof query.page === 'number' && (!Number.isInteger(query.page) || query.page < 1)) {
      throw new HuduConfigError(`page must be a positive integer, got "${String(query.page)}"`);
    }
    const firstPage = typeof query.page === 'number' ? query.page : 1;
    delete query.page;
    delete query.page_size;
    let serverPageSize: number | undefined; // server's full-page size, once learned
    // Content fingerprint of the previous continuing page, for no-progress
    // detection (codex PR [17]): a server that ignores `page` but keeps
    // returning the same full, continuing page must not yield duplicates.
    let prevSignature: string | null = null;
    let offset = 0;
    while (true) {
      if (offset >= MAX_PAGES) {
        throw new HuduConfigError(`Pagination exceeded ${MAX_PAGES} pages; refusing to continue (possible runaway loop)`);
      }
      const body = await this.http.request<unknown>({
        method: 'GET',
        path: '/asset_layouts',
        query: { ...query, page: firstPage + offset },
        operation: 'asset_layouts.list',
      });
      const items = this.unwrapList<AssetLayout>(body);
      // Track the largest non-empty page as the server's full-page size.
      if (items.length > (serverPageSize ?? 0)) serverPageSize = items.length;
      const effective = serverPageSize ?? 25;
      const continuing = items.length === effective && items.length > 0;
      // No-progress guard: a continuing full page whose content matches the
      // previous continuing page means the server ignored `page`.
      if (continuing) {
        const signature = AssetLayoutsResource.assetLayoutSignature(items);
        if (prevSignature !== null && signature === prevSignature) {
          throw new HuduConfigError(
            'Pagination made no progress: /asset_layouts returned the same full page content repeatedly; is the endpoint ignoring `page`?',
          );
        }
        prevSignature = signature;
      }
      yield { items, page: firstPage + offset, page_size: effective, hasMore: continuing };
      if (!continuing) break;
      offset += 1;
    }
  }

  private async *assetLayoutItems(params: AssetLayoutsListParams): AsyncGenerator<AssetLayout> {
    for await (const page of this.assetLayoutPages(params)) {
      for (const item of page.items) yield item;
    }
  }

  /**
   * Cheap, stable fingerprint of an asset-layout page for no-progress detection
   * (mirrors pagination.pageSignature). Prefers `id` when present.
   */
  private static assetLayoutSignature(items: AssetLayout[]): string {
    return items
      .map((it) => {
        const id = (it as { id?: unknown }).id;
        return id !== undefined ? `i:${String(id)}` : `v:${JSON.stringify(it)}`;
      })
      .join(',');
  }
}
