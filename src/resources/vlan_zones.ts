/**
 * VlanZonesResource — Hudu "vlan_zones" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { VlanZone, VlanZoneCreate, VlanZoneUpdate } from '../types/index.js';

export interface VlanZonesListParams extends ListParams {
  company_id: number;
  name: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export class VlanZonesResource extends BaseResource<VlanZone> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'vlan_zones', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a vlan_zones by id. */
  async get(id: number): Promise<VlanZone> {
    return this.getOne<VlanZone>(id);
  }
  /** Stream vlan_zones across pages. */
  list(params?: VlanZonesListParams): AsyncIterable<VlanZone> {
    return this.items(params ?? {});
  }
  /** Get every vlan_zones. MCP-preferred read. */
  async listAll(params?: VlanZonesListParams): Promise<VlanZone[]> {
    return this.all(params ?? {});
  }
  async create(data: VlanZoneCreate): Promise<VlanZone> {
    return this.createOne<VlanZone>(data);
  }
  async update(id: number, data: VlanZoneUpdate): Promise<VlanZone> {
    return this.updateOne<VlanZone>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: VlanZonesListParams): AsyncIterable<Page<VlanZone>> {
    return this.pageIter(params ?? {});
  }


}
