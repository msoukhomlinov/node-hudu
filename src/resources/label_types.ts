/**
 * LabelTypesResource — Hudu "label_types" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { LabelType, LabelTypeCreate, LabelTypeUpdate } from '../types/index.js';

export interface LabelTypesListParams extends ListParams {
  name: string;
  color: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

export class LabelTypesResource extends BaseResource<LabelType> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'label_types', singleKey: 'label_type', listKey: 'label_types', createType: 'wrapped', paginated: true });
  }

  /** Get a label_types by id. */
  async get(id: number): Promise<LabelType> {
    return this.getOne<LabelType>(id);
  }
  /** Stream label_types across pages. */
  list(params?: LabelTypesListParams): AsyncIterable<LabelType> {
    return this.items(params ?? {});
  }
  /** Get every label_types. MCP-preferred read. */
  async listAll(params?: LabelTypesListParams): Promise<LabelType[]> {
    return this.all(params ?? {});
  }
  async create(data: LabelTypeCreate): Promise<LabelType> {
    return this.createOne<LabelType>(data);
  }
  async update(id: number, data: LabelTypeUpdate): Promise<LabelType> {
    return this.updateOne<LabelType>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: LabelTypesListParams): AsyncIterable<Page<LabelType>> {
    return this.pageIter(params ?? {});
  }


}
