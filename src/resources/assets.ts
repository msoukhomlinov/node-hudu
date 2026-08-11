/**
 * AssetsResource — Hudu "companies/{companyId}/assets" resource (company-scoped).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page, PaginateOptions } from '../pagination.js';
import { collectAll, paginate, paginateItems } from '../pagination.js';
import type { Asset, AssetCreate, AssetUpdate } from '../types/index.js';

export interface CompanyAssetsListParams extends ListParams {
  archived?: boolean;
}

export interface AccountAssetsListParams extends ListParams {
  company_id?: number;
  id?: number;
  name?: string;
  primary_serial?: string;
  asset_layout_id?: number;
  archived?: boolean;
  slug?: string;
  search?: string;
  updated_at?: string;
}

export class AssetsResource extends BaseResource<Asset> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'companies/{companyId}/assets', singleKey: 'asset', listKey: 'assets', createType: 'raw', paginated: true });
  }

  async get(companyId: number, id: number): Promise<Asset> {
    const body = await this.http.request<unknown>({ method: 'GET', path: `/companies/${companyId}/assets/${id}` });
    return this.unwrapSingle<Asset>(body);
  }

  list(companyId: number, params?: CompanyAssetsListParams): AsyncIterable<Asset> {
    return paginateItems<Asset>((page, pageSize) => this.fetchScopedPage(companyId, params ?? {}, page, pageSize), this.companyPaginationOpts(params));
  }

  async listAll(companyId: number, params?: CompanyAssetsListParams): Promise<Asset[]> {
    return collectAll<Asset>((page, pageSize) => this.fetchScopedPage(companyId, params ?? {}, page, pageSize), this.companyPaginationOpts(params));
  }

  listPages(companyId: number, params?: CompanyAssetsListParams): AsyncIterable<Page<Asset>> {
    return paginate<Asset>((page, pageSize) => this.fetchScopedPage(companyId, params ?? {}, page, pageSize), this.companyPaginationOpts(params));
  }

  async create(companyId: number, data: AssetCreate): Promise<Asset> {
    // A-1/QA: the live n8n node and the PUT example wrap the body in { asset };
    // POST example in the spec is flat but the working live node wraps it too.
    // The 201 response is a flat Asset, so no unwrap is applied.
    const body = await this.http.request<unknown>({ method: 'POST', path: `/companies/${companyId}/assets`, body: { asset: data } });
    return body as Asset;
  }

  /** PUT /companies/{companyId}/assets/{id}. Wraps the body in { asset } — the api-docs.json PUT example and the live n8n node (_assetFieldUtils_ ~L522) both nest it; the 200 response is a flat Asset, so no unwrap is applied (A-1/R6). */
  async update(companyId: number, id: number, data: AssetUpdate): Promise<Asset> {
    const body = await this.http.request<unknown>({ method: 'PUT', path: `/companies/${companyId}/assets/${id}`, body: { asset: data } });
    return body as Asset;
  }

  async delete(companyId: number, id: number): Promise<void> {
    await this.http.request<unknown>({ method: 'DELETE', path: `/companies/${companyId}/assets/${id}` });
  }

  async archive(companyId: number, id: number): Promise<void> {
    await this.http.request<unknown>({ method: 'PUT', path: `/companies/${companyId}/assets/${id}/archive` });
  }

  async unarchive(companyId: number, id: number): Promise<void> {
    await this.http.request<unknown>({ method: 'PUT', path: `/companies/${companyId}/assets/${id}/unarchive` });
  }

  async moveLayout(companyId: number, id: number, data: { asset_layout_id: number }): Promise<Asset> {
    const body = await this.http.request<unknown>({ method: 'PUT', path: `/companies/${companyId}/assets/${id}/move_layout`, body: data });
    return body as Asset;
  }

  async listAllAcrossCompanies(params?: AccountAssetsListParams): Promise<Asset[]> {
    return collectAll<Asset>((page, pageSize) => this.fetchAccountPage(params ?? {}, page, pageSize), this.accountPaginationOpts(params));
  }

  /** Stream account-wide assets across pages (GET /assets). */
  listAcrossCompanies(params?: AccountAssetsListParams): AsyncIterable<Asset> {
    return paginateItems<Asset>((page, pageSize) => this.fetchAccountPage(params ?? {}, page, pageSize), this.accountPaginationOpts(params));
  }

  /** Iterate account-wide asset pages (GET /assets). */
  listAcrossCompaniesPages(params?: AccountAssetsListParams): AsyncIterable<Page<Asset>> {
    return paginate<Asset>((page, pageSize) => this.fetchAccountPage(params ?? {}, page, pageSize), this.accountPaginationOpts(params));
  }

  /**
   * Extract the caller's `page`/`page_size` from account-wide list params and
   * thread them as PaginateOptions into the raw pagination helpers (mirrors
   * BaseResource.paginationOpts, but here the account-wide fetchers call the
   * raw collectAll/paginateItems/paginate directly). Without this, the helpers
   * would start at page 1 with the default page_size 25, silently swallowing a
   * caller's `page`/`page_size`.
   */
  private companyPaginationOpts(params?: ListParams): PaginateOptions {
    const page = typeof params?.page === 'number' ? params.page : undefined;
    const page_size = typeof params?.page_size === 'number' ? params.page_size : undefined;
    // Enable the content-based no-progress guard (mirrors accountPaginationOpts).
    return { page, page_size, guardNoProgress: true };
  }

  private accountPaginationOpts(params?: ListParams): PaginateOptions {
    const page = typeof params?.page === 'number' ? params.page : undefined;
    const page_size = typeof params?.page_size === 'number' ? params.page_size : undefined;
    // codex PR review [15]: enable the content-based no-progress guard so a
    // server that ignores `page` (repeats the same full page) yields an error
    // instead of duplicate items / a 100k-request loop.
    return { page, page_size, guardNoProgress: true };
  }

  private async fetchScopedPage(companyId: number, params: ListParams, page: number, pageSize: number) {
    const body = await this.http.request<unknown>({ method: 'GET', path: `/companies/${companyId}/assets`, query: { ...params, page, page_size: pageSize } });
    const items = this.unwrapList<Asset>(body);
    return { items, page, page_size: pageSize, hasMore: items.length === pageSize };
  }

  private async fetchAccountPage(params: ListParams, page: number, pageSize: number) {
    // `page`/`pageSize` come from the thread-through PaginateOptions; spread
    // params first so any caller-supplied page/page_size are overlaid by the
    // effective looper values (which now honour the caller's page/page_size).
    const body = await this.http.request<unknown>({ method: 'GET', path: `/assets`, query: { ...params, page, page_size: pageSize } });
    const items = this.unwrapList<Asset>(body);
    return { items, page, page_size: pageSize, hasMore: items.length === pageSize };
  }
}
