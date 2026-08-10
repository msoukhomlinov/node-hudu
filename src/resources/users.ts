/**
 * UsersResource — Hudu "users" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { User } from '../types/index.js';

export interface UsersListParams extends ListParams {
  first_name?: string;
  last_name?: string;
  search?: string;
  portal_member_company_id?: number;
  archived?: boolean;
  email?: string;
  security_level?: string;
}

export class UsersResource extends BaseResource<User> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'users', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /** Get a users by id. */
  async get(id: number): Promise<User> {
    return this.getOne<User>(id);
  }
  /** Stream users across pages. */
  list(params?: UsersListParams): AsyncIterable<User> {
    return this.items(params ?? {});
  }
  /** Get every users. MCP-preferred read. */
  async listAll(params?: UsersListParams): Promise<User[]> {
    return this.all(params ?? {});
  }

  listPages(params?: UsersListParams): AsyncIterable<Page<User>> {
    return this.pageIter(params ?? {});
  }


}
