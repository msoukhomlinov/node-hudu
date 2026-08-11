/**
 * WebsitesResource — Hudu "websites" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Website, WebsiteCreate, WebsiteUpdate } from '../types/index.js';

export interface WebsitesListParams extends ListParams {
  name?: string;
  slug?: string;
  search?: string;
  updated_at?: string;
}

export class WebsitesResource extends BaseResource<Website> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'websites', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /** Get a websites by id. */
  async get(id: number): Promise<Website> {
    return this.getOne<Website>(id);
  }
  /** Stream websites across pages. */
  list(params?: WebsitesListParams): AsyncIterable<Website> {
    return this.items(params ?? {});
  }
  /** Get every websites. MCP-preferred read. */
  async listAll(params?: WebsitesListParams): Promise<Website[]> {
    return this.all(params ?? {});
  }
  async create(data: WebsiteCreate): Promise<Website> {
    return this.createOne<Website>({ website: data });
  }
  async update(id: number, data: WebsiteUpdate): Promise<Website> {
    return this.updateOne<Website>(id, { website: data });
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: WebsitesListParams): AsyncIterable<Page<Website>> {
    return this.pageIter(params ?? {});
  }


}
