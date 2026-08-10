/**
 * RelationsResource — Hudu "relations" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Relation, RelationCreate } from '../types/index.js';

export interface RelationsListParams extends ListParams {
  fromable_type: string;
  fromable_id: number;
  toable_type: string;
  toable_id: number;
  is_inverse: boolean;
  description: string;
  created_at: string;
  updated_at: string;
}

export class RelationsResource extends BaseResource<Relation> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'relations', singleKey: undefined, listKey: 'relations', createType: 'wrapped', paginated: true });
  }

  /** Stream relations across pages. */
  list(params?: RelationsListParams): AsyncIterable<Relation> {
    return this.items(params ?? {});
  }
  /** Get every relations. MCP-preferred read. */
  async listAll(params?: RelationsListParams): Promise<Relation[]> {
    return this.all(params ?? {});
  }
  async create(data: RelationCreate): Promise<Relation> {
    return this.createOne<Relation>(data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: RelationsListParams): AsyncIterable<Page<Relation>> {
    return this.pageIter(params ?? {});
  }


}
