/**
 * PasswordFoldersResource — Hudu "password_folders" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { PasswordFolder, PasswordFolderCreate, PasswordFolderUpdate } from '../types/index.js';

export interface PasswordFoldersListParams extends ListParams {
  name?: string;
  company_id?: number;
  search?: string;
}

export class PasswordFoldersResource extends BaseResource<PasswordFolder> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'password_folders', singleKey: 'password_folder', listKey: 'password_folders', createType: 'wrapped', paginated: true });
  }

  /** Get a password_folders by id. */
  async get(id: number): Promise<PasswordFolder> {
    return this.getOne<PasswordFolder>(id);
  }
  /** Stream password_folders across pages. */
  list(params?: PasswordFoldersListParams): AsyncIterable<PasswordFolder> {
    return this.items(params ?? {});
  }
  /** Get every password_folders. MCP-preferred read. */
  async listAll(params?: PasswordFoldersListParams): Promise<PasswordFolder[]> {
    return this.all(params ?? {});
  }
  async create(data: PasswordFolderCreate): Promise<PasswordFolder> {
    return this.createOne<PasswordFolder>(data);
  }
  async update(id: number, data: PasswordFolderUpdate): Promise<PasswordFolder> {
    return this.updateOne<PasswordFolder>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: PasswordFoldersListParams): AsyncIterable<Page<PasswordFolder>> {
    return this.pageIter(params ?? {});
  }


}
