/**
 * AssetLayoutsResource — Hudu "asset_layouts" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { AssetLayout, AssetLayoutCreate, AssetLayoutUpdate } from '../types/index.js';

export interface AssetLayoutsListParams extends ListParams {
  name: string;
  slug: string;
  active: boolean;
  updated_at: string;
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
    return this.items(params ?? {});
  }
  /** Get every asset_layouts. MCP-preferred read. */
  async listAll(params?: AssetLayoutsListParams): Promise<AssetLayout[]> {
    return this.all(params ?? {});
  }
  async create(data: AssetLayoutCreate): Promise<AssetLayout> {
    return this.createOne<AssetLayout>(data);
  }
  async update(id: number, data: AssetLayoutUpdate): Promise<AssetLayout> {
    return this.updateOne<AssetLayout>(id, data);
  }

  listPages(params?: AssetLayoutsListParams): AsyncIterable<Page<AssetLayout>> {
    return this.pageIter(params ?? {});
  }


}
