/**
 * ProceduresResource — Hudu "procedures" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Procedure, ProcedureCreate, ProcedureUpdate } from '../types/index.js';

export interface ProceduresListParams extends ListParams {
  type: string;
  process_scope: string;
  parent_process_id: number;
  name: string;
  company_id: number;
  slug: string;
  created_at: string;
  updated_at: string;
  archived: string;
  global_template: string;
  company_template: number;
  parent_procedure_id: number;
}

export class ProceduresResource extends BaseResource<Procedure> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'procedures', singleKey: 'procedure', listKey: 'procedures', createType: 'raw', paginated: true });
  }

  /** Get a procedures by id. */
  async get(id: number): Promise<Procedure> {
    return this.getOne<Procedure>(id);
  }
  /** Stream procedures across pages. */
  list(params?: ProceduresListParams): AsyncIterable<Procedure> {
    return this.items(params ?? {});
  }
  /** Get every procedures. MCP-preferred read. */
  async listAll(params?: ProceduresListParams): Promise<Procedure[]> {
    return this.all(params ?? {});
  }
  async create(data: ProcedureCreate): Promise<Procedure> {
    return this.createOne<Procedure>(data);
  }
  async update(id: number, data: ProcedureUpdate): Promise<Procedure> {
    return this.updateOne<Procedure>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: ProceduresListParams): AsyncIterable<Page<Procedure>> {
    return this.pageIter(params ?? {});
  }


}
