/**
 * IpAddressesResource — Hudu "ip_addresses" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { IpAddress, IpAddressCreate, IpAddressUpdate } from '../types/index.js';

export interface IpAddressesListParams extends ListParams {
  network_id: number;
  address: string;
  status: string;
  fqdn: string;
  asset_id: number;
  company_id: number;
  created_at: string;
  updated_at: string;
}

export class IpAddressesResource extends BaseResource<IpAddress> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'ip_addresses', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a ip_addresses by id. */
  async get(id: number): Promise<IpAddress> {
    return this.getOne<IpAddress>(id);
  }
  /** Stream ip_addresses across pages. */
  list(params?: IpAddressesListParams): AsyncIterable<IpAddress> {
    return this.items(params ?? {});
  }
  /** Get every ip_addresses. MCP-preferred read. */
  async listAll(params?: IpAddressesListParams): Promise<IpAddress[]> {
    return this.all(params ?? {});
  }
  async create(data: IpAddressCreate): Promise<IpAddress> {
    return this.createOne<IpAddress>(data);
  }
  async update(id: number, data: IpAddressUpdate): Promise<IpAddress> {
    return this.updateOne<IpAddress>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: IpAddressesListParams): AsyncIterable<Page<IpAddress>> {
    return this.pageIter(params ?? {});
  }


}
