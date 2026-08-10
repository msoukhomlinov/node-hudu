/**
 * AssetPasswordsResource — Hudu "asset_passwords" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { AssetPassword, AssetPasswordCreate, AssetPasswordUpdate } from '../types/index.js';

export interface AssetPasswordsListParams extends ListParams {
  name?: string;
  company_id?: number;
  archived?: boolean;
  slug?: string;
  search?: string;
  updated_at?: string;
}

export class AssetPasswordsResource extends BaseResource<AssetPassword> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'asset_passwords', singleKey: 'asset_password', listKey: 'asset_passwords', createType: 'wrapped', paginated: true });
  }

  /** Get a asset_passwords by id. */
  async get(id: number): Promise<AssetPassword> {
    return this.getOne<AssetPassword>(id);
  }
  /** Stream asset_passwords across pages. */
  list(params?: AssetPasswordsListParams): AsyncIterable<AssetPassword> {
    return this.items(params ?? {});
  }
  /** Get every asset_passwords. MCP-preferred read. */
  async listAll(params?: AssetPasswordsListParams): Promise<AssetPassword[]> {
    return this.all(params ?? {});
  }
  async create(data: AssetPasswordCreate): Promise<AssetPassword> {
    return this.createOne<AssetPassword>(data);
  }
  async update(id: number, data: AssetPasswordUpdate): Promise<AssetPassword> {
    return this.updateOne<AssetPassword>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }
  async archive(id: number): Promise<void> {
    return this.setArchived(id, true);
  }
  async unarchive(id: number): Promise<void> {
    return this.setArchived(id, false);
  }

  listPages(params?: AssetPasswordsListParams): AsyncIterable<Page<AssetPassword>> {
    return this.pageIter(params ?? {});
  }


}
