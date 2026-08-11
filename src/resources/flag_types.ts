/**
 * FlagTypesResource — Hudu "flag_types" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { FlagType, FlagTypeCreate, FlagTypeUpdate } from '../types/index.js';

export interface FlagTypesListParams extends ListParams {
  name?: string;
  color?: string;
  slug?: string;
  created_at?: string;
  updated_at?: string;
}

export class FlagTypesResource extends BaseResource<FlagType> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'flag_types', singleKey: 'flag_type', listKey: 'flag_types', createType: 'wrapped', paginated: true });
  }

  /** Get a flag_types by id. */
  async get(id: number): Promise<FlagType> {
    return this.getOne<FlagType>(id);
  }
  /** Stream flag_types across pages. */
  list(params?: FlagTypesListParams): AsyncIterable<FlagType> {
    return this.items(params ?? {});
  }
  /** Get every flag_types. MCP-preferred read. */
  async listAll(params?: FlagTypesListParams): Promise<FlagType[]> {
    return this.all(params ?? {});
  }
  async create(data: FlagTypeCreate): Promise<FlagType> {
    return this.createOne<FlagType>({ flag_type: data });
  }
  async update(id: number, data: FlagTypeUpdate): Promise<FlagType> {
    return this.updateOne<FlagType>(id, { flag_type: data });
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: FlagTypesListParams): AsyncIterable<Page<FlagType>> {
    return this.pageIter(params ?? {});
  }


}
