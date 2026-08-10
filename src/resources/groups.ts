/**
 * GroupsResource — Hudu "groups" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Group } from '../types/index.js';

export interface GroupsListParams extends ListParams {
  name: string;
  default: boolean;
  search: string;
}

export class GroupsResource extends BaseResource<Group> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'groups', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /** Get a groups by id. */
  async get(id: number): Promise<Group> {
    return this.getOne<Group>(id);
  }
  /** Stream groups across pages. */
  list(params?: GroupsListParams): AsyncIterable<Group> {
    return this.items(params ?? {});
  }
  /** Get every groups. MCP-preferred read. */
  async listAll(params?: GroupsListParams): Promise<Group[]> {
    return this.all(params ?? {});
  }

  listPages(params?: GroupsListParams): AsyncIterable<Page<Group>> {
    return this.pageIter(params ?? {});
  }


}
