/**
 * RackStorageItemsResource — Hudu "rack_storage_items" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { RackStorageItem, RackStorageItemCreate, RackStorageItemUpdate } from '../types/index.js';

export interface RackStorageItemsListParams extends ListParams {
  rack_storage_role_id?: number;
  asset_id?: number;
  start_unit?: number;
  end_unit?: number;
  status?: number;
  side?: string;
  created_at?: string;
  updated_at?: string;
}

export class RackStorageItemsResource extends BaseResource<RackStorageItem> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'rack_storage_items', singleKey: undefined, listKey: undefined, createType: 'wrapped', paginated: false });
  }

  /** Get a rack_storage_items by id. */
  async get(id: number): Promise<RackStorageItem> {
    return this.getOne<RackStorageItem>(id);
  }
  /** Stream rack_storage_items across pages. */
  list(params?: RackStorageItemsListParams): AsyncIterable<RackStorageItem> {
    return this.items(params ?? {});
  }
  /** Get every rack_storage_items. MCP-preferred read. */
  async listAll(params?: RackStorageItemsListParams): Promise<RackStorageItem[]> {
    return this.all(params ?? {});
  }
  async create(data: RackStorageItemCreate): Promise<RackStorageItem> {
    return this.createOne<RackStorageItem>(data);
  }
  async update(id: number, data: RackStorageItemUpdate): Promise<RackStorageItem> {
    return this.updateOne<RackStorageItem>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: RackStorageItemsListParams): AsyncIterable<Page<RackStorageItem>> {
    return this.pageIter(params ?? {});
  }


}
