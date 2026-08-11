/**
 * LabelsResource — Hudu "labels" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Label, LabelCreate, LabelUpdate } from '../types/index.js';

export interface LabelsListParams extends ListParams {
  label_type_id?: number;
  labelable_type?: string;
  labelable_id?: number;
  user_id?: number;
  created_at?: string;
  updated_at?: string;
}

export class LabelsResource extends BaseResource<Label> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'labels', singleKey: 'label', listKey: 'labels', createType: 'wrapped', paginated: true });
  }

  /** Get a labels by id. */
  async get(id: number): Promise<Label> {
    return this.getOne<Label>(id);
  }
  /** Stream labels across pages. */
  list(params?: LabelsListParams): AsyncIterable<Label> {
    return this.items(params ?? {});
  }
  /** Get every labels. MCP-preferred read. */
  async listAll(params?: LabelsListParams): Promise<Label[]> {
    return this.all(params ?? {});
  }
  async create(data: LabelCreate): Promise<Label> {
    return this.createOne<Label>({ label: data });
  }
  async update(id: number, data: LabelUpdate): Promise<Label> {
    return this.updateOne<Label>(id, { label: data });
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: LabelsListParams): AsyncIterable<Page<Label>> {
    return this.pageIter(params ?? {});
  }


}
