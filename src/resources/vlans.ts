/**
 * VlansResource — Hudu "vlans" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Vlan, VlanCreate, VlanUpdate } from '../types/index.js';

export interface VlansListParams extends ListParams {
  company_id?: number;
  vlan_zone_id?: number;
  name?: string;
  vlan_id?: number;
  created_at?: string;
  updated_at?: string;
  archived?: boolean;
}

export class VlansResource extends BaseResource<Vlan> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'vlans', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a vlans by id. */
  async get(id: number): Promise<Vlan> {
    return this.getOne<Vlan>(id);
  }
  /** Stream vlans across pages. */
  list(params?: VlansListParams): AsyncIterable<Vlan> {
    return this.items(params ?? {});
  }
  /** Get every vlans. MCP-preferred read. */
  async listAll(params?: VlansListParams): Promise<Vlan[]> {
    return this.all(params ?? {});
  }
  async create(data: VlanCreate): Promise<Vlan> {
    return this.createOne<Vlan>(data);
  }
  async update(id: number, data: VlanUpdate): Promise<Vlan> {
    return this.updateOne<Vlan>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: VlansListParams): AsyncIterable<Page<Vlan>> {
    return this.pageIter(params ?? {});
  }


}
