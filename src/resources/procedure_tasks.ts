/**
 * ProcedureTasksResource — Hudu "procedure_tasks" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { ProcedureTask, ProcedureTaskCreate, ProcedureTaskUpdate } from '../types/index.js';

export interface ProcedureTasksListParams extends ListParams {
  procedure_id?: number;
  name?: string;
  company_id?: number;
}

export class ProcedureTasksResource extends BaseResource<ProcedureTask> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'procedure_tasks', singleKey: 'procedure_task', listKey: 'procedure_tasks', createType: 'wrapped', paginated: false });
  }

  /** Get a procedure_tasks by id. */
  async get(id: number): Promise<ProcedureTask> {
    return this.getOne<ProcedureTask>(id);
  }
  /** Stream procedure_tasks across pages. */
  list(params?: ProcedureTasksListParams): AsyncIterable<ProcedureTask> {
    return this.items(params ?? {});
  }
  /** Get every procedure_tasks. MCP-preferred read. */
  async listAll(params?: ProcedureTasksListParams): Promise<ProcedureTask[]> {
    return this.all(params ?? {});
  }
  async create(data: ProcedureTaskCreate): Promise<ProcedureTask> {
    return this.createOne<ProcedureTask>(data);
  }
  async update(id: number, data: ProcedureTaskUpdate): Promise<ProcedureTask> {
    return this.updateOne<ProcedureTask>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: ProcedureTasksListParams): AsyncIterable<Page<ProcedureTask>> {
    return this.pageIter(params ?? {});
  }


}
