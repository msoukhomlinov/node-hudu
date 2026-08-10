/**
 * NetworksResource — Hudu "networks" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Network, NetworkCreate, NetworkUpdate } from '../types/index.js';

export interface NetworksListParams extends ListParams {
  company_id?: number;
  slug?: string;
  name?: string;
  network_type?: number;
  address?: string;
  location_id?: number;
  created_at?: string;
  updated_at?: string;
  archived?: boolean;
}

export class NetworksResource extends BaseResource<Network> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'networks', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a networks by id. */
  async get(id: number): Promise<Network> {
    return this.getOne<Network>(id);
  }
  /** Stream networks across pages. */
  list(params?: NetworksListParams): AsyncIterable<Network> {
    return this.items(params ?? {});
  }
  /** Get every networks. MCP-preferred read. */
  async listAll(params?: NetworksListParams): Promise<Network[]> {
    return this.all(params ?? {});
  }
  async create(data: NetworkCreate): Promise<Network> {
    return this.createOne<Network>(data);
  }
  async update(id: number, data: NetworkUpdate): Promise<Network> {
    return this.updateOne<Network>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: NetworksListParams): AsyncIterable<Page<Network>> {
    return this.pageIter(params ?? {});
  }


}
