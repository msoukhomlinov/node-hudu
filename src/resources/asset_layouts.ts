/**
 * AssetLayoutsResource — Hudu "asset_layouts" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { AssetLayout, AssetLayoutCreate, AssetLayoutUpdate } from '../types/index.js';
import { HuduConfigError } from '../errors.js';

/** Upper bound on server-side pages walked before refusing (runaway guard). */
const MAX_PAGES = 100_000;

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
  async create(data: AssetLayoutCreate): Promise<AssetLayout> {
    return this.createOne<AssetLayout>(data);
  }
  async update(id: number, data: AssetLayoutUpdate): Promise<AssetLayout> {
    return this.updateOne<AssetLayout>(id, data);
  }

  listPages(params?: AssetLayoutsListParams): AsyncIterable<Page<AssetLayout>> {
    return this.assetLayoutPages(params ?? {});
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

