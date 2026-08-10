/**
 * FoldersResource — Hudu "folders" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Folder, FolderCreate, FolderUpdate } from '../types/index.js';

export interface FoldersListParams extends ListParams {
  name?: string;
  company_id?: number;
  in_company?: boolean;
  folder_type?: string;
}

export class FoldersResource extends BaseResource<Folder> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'folders', singleKey: 'folder', listKey: 'folders', createType: 'wrapped', paginated: true });
  }

  /** Get a folders by id. */
  async get(id: number): Promise<Folder> {
    return this.getOne<Folder>(id);
  }
  /** Stream folders across pages. */
  list(params?: FoldersListParams): AsyncIterable<Folder> {
    return this.items(params ?? {});
  }
  /** Get every folders. MCP-preferred read. */
  async listAll(params?: FoldersListParams): Promise<Folder[]> {
    return this.all(params ?? {});
  }
  async create(data: FolderCreate): Promise<Folder> {
    return this.createOne<Folder>(data);
  }
  async update(id: number, data: FolderUpdate): Promise<Folder> {
    return this.updateOne<Folder>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: FoldersListParams): AsyncIterable<Page<Folder>> {
    return this.pageIter(params ?? {});
  }


}
