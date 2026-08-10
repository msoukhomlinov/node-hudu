/**
 * AssetsResource — Hudu "companies/{companyId}/assets" resource (company-scoped).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
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
    return paginateItems<Asset>((page, pageSize) => this.fetchScopedPage(companyId, params ?? {}, page, pageSize));
  }

  async listAll(companyId: number, params?: CompanyAssetsListParams): Promise<Asset[]> {
    return collectAll<Asset>((page, pageSize) => this.fetchScopedPage(companyId, params ?? {}, page, pageSize));
  }

  listPages(companyId: number, params?: CompanyAssetsListParams): AsyncIterable<Page<Asset>> {
    return paginate<Asset>((page, pageSize) => this.fetchScopedPage(companyId, params ?? {}, page, pageSize));
  }

  async create(companyId: number, data: AssetCreate): Promise<Asset> {
    const body = await this.http.request<unknown>({ method: 'POST', path: `/companies/${companyId}/assets`, body: data });
    return body as Asset;
  }

  async update(companyId: number, id: number, data: AssetUpdate): Promise<Asset> {
    const body = await this.http.request<unknown>({ method: 'PUT', path: `/companies/${companyId}/assets/${id}`, body: data });
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
    return collectAll<Asset>((page, pageSize) => this.fetchAccountPage(params ?? {}, page, pageSize));
  }

  private async fetchScopedPage(companyId: number, params: ListParams, page: number, pageSize: number) {
    const body = await this.http.request<unknown>({ method: 'GET', path: `/companies/${companyId}/assets`, query: { ...params, page, page_size: pageSize } });
    const items = this.unwrapList<Asset>(body);
    return { items, page, page_size: pageSize, hasMore: items.length === pageSize };
  }

  private async fetchAccountPage(params: ListParams, page: number, pageSize: number) {
    const body = await this.http.request<unknown>({ method: 'GET', path: `/assets`, query: { ...params, page, page_size: pageSize } });
    const items = this.unwrapList<Asset>(body);
    return { items, page, page_size: pageSize, hasMore: items.length === pageSize };
  }
}
