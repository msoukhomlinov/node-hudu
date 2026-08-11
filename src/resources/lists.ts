/**
 * ListsResource — Hudu "lists" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { List, ListCreate, ListUpdate } from '../types/index.js';

export interface ListsListParams extends ListParams {
  query?: string;
  name?: string;
}

export class ListsResource extends BaseResource<List> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'lists', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** Get a lists by id. */
  async get(id: number): Promise<List> {
    return this.getOne<List>(id);
  }
  /** Stream lists across pages. */
  list(params?: ListsListParams): AsyncIterable<List> {
    return this.items(params ?? {});
  }
  /** Get every lists. MCP-preferred read. */
  async listAll(params?: ListsListParams): Promise<List[]> {
    return this.all(params ?? {});
  }
  async create(data: ListCreate): Promise<List> {
    return this.createOne<List>({ list: data });
  }
  async update(id: number, data: ListUpdate): Promise<List> {
    return this.updateOne<List>(id, { list: data });
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: ListsListParams): AsyncIterable<Page<List>> {
    return this.pageIter(params ?? {});
  }


}
