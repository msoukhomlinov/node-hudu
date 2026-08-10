/**
 * RackStoragesResource — Hudu "rack_storages" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { RackStorage, RackStorageCreate, RackStorageUpdate } from '../types/index.js';

export interface RackStoragesListParams extends ListParams {
  company_id?: number;
  location_id?: number;
  height?: number;
  min_width?: number;
  max_width?: number;
  created_at?: string;
  updated_at?: string;
}

export class RackStoragesResource extends BaseResource<RackStorage> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'rack_storages', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a rack_storages by id. */
  async get(id: number): Promise<RackStorage> {
    return this.getOne<RackStorage>(id);
  }
  /** Stream rack_storages across pages. */
  list(params?: RackStoragesListParams): AsyncIterable<RackStorage> {
    return this.items(params ?? {});
  }
  /** Get every rack_storages. MCP-preferred read. */
  async listAll(params?: RackStoragesListParams): Promise<RackStorage[]> {
    return this.all(params ?? {});
  }
  async create(data: RackStorageCreate): Promise<RackStorage> {
    return this.createOne<RackStorage>(data);
  }
  async update(id: number, data: RackStorageUpdate): Promise<RackStorage> {
    return this.updateOne<RackStorage>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: RackStoragesListParams): AsyncIterable<Page<RackStorage>> {
    return this.pageIter(params ?? {});
  }


}
