/**
 * FlagsResource — Hudu "flags" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Flag, FlagCreate, FlagUpdate } from '../types/index.js';

export interface FlagsListParams extends ListParams {
  flag_type_id?: number;
  flagable_type?: string;
  flagable_id?: number;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export class FlagsResource extends BaseResource<Flag> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'flags', singleKey: 'flag', listKey: 'flags', createType: 'wrapped', paginated: true });
  }

  /** Get a flags by id. */
  async get(id: number): Promise<Flag> {
    return this.getOne<Flag>(id);
  }
  /** Stream flags across pages. */
  list(params?: FlagsListParams): AsyncIterable<Flag> {
    return this.items(params ?? {});
  }
  /** Get every flags. MCP-preferred read. */
  async listAll(params?: FlagsListParams): Promise<Flag[]> {
    return this.all(params ?? {});
  }
  async create(data: FlagCreate): Promise<Flag> {
    return this.createOne<Flag>({ flag: data });
  }
  async update(id: number, data: FlagUpdate): Promise<Flag> {
    return this.updateOne<Flag>(id, { flag: data });
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: FlagsListParams): AsyncIterable<Page<Flag>> {
    return this.pageIter(params ?? {});
  }


}
