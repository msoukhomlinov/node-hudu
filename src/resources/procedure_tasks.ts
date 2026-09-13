/**
 * ProcedureTasksResource — Hudu "procedure_tasks" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { DryRunResult, Identifier, MutationOptions, Resolution, ResolutionOptions } from '../types/common.js';
import type { ProcedureTask, ProcedureTaskCreate, ProcedureTaskUpdate } from '../types/index.js';
import type { ProcedureTaskSummary } from '../types/procedure_task.js';
import { HuduConfigError } from '../errors.js';
import {
  decideResolution, helperLimit, identifierError,
  refuseExpectedUpdatedAtOutsideUpdate, requirePositiveId,
} from './agent-layer-helpers.js';

export interface ProcedureTasksListParams extends ListParams {
  procedure_id?: number;
  name?: string;
  company_id?: number;
}

/** Compact projection of one procedure task (policy §9). */
export function toProcedureTaskSummary(record: ProcedureTask): ProcedureTaskSummary {
  return {
    id: record.id,
    name: record.name,
    position: record.position,
    priority: record.priority,
    completed: record.completed,
    completed_date: record.completed_date,
    due_date: record.due_date,
    procedure_id: record.procedure_id,
    optional: record.optional,
    parent_task_id: record.parent_task_id,
    has_subtasks: record.has_subtasks,
    subtask_count: record.subtask_count,
    first_assigned_user_name: record.first_assigned_user_name,
    url: record.url,
    updated_at: record.updated_at,
  };
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

  /** POST /procedure_tasks. */
  async create(data: ProcedureTaskCreate): Promise<ProcedureTask>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: ProcedureTaskCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<ProcedureTask>>;
  /** Live create; `expectedUpdatedAt` has no meaning for a record that does not exist yet. */
  async create(data: ProcedureTaskCreate, opts: MutationOptions & { dryRun?: false }): Promise<ProcedureTask>;
  async create(data: ProcedureTaskCreate, opts: MutationOptions | undefined): Promise<ProcedureTask | DryRunResult<ProcedureTask>>;
  async create(data: ProcedureTaskCreate, opts?: MutationOptions): Promise<ProcedureTask | DryRunResult<ProcedureTask>> {
    // staleCheck is "unavailable" for a create: `expectedUpdatedAt` is refused, not ignored.
    refuseExpectedUpdatedAtOutsideUpdate('procedure_tasks.create', opts);
    return this.createOne<ProcedureTask>(data, undefined, opts);
  }

  /** PUT /procedure_tasks/{id}. */
  async update(id: number, data: ProcedureTaskUpdate): Promise<ProcedureTask>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: ProcedureTaskUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<ProcedureTask>>;
  /** Live update; `{ expectedUpdatedAt }` adds the opt-in stale guard. */
  async update(id: number, data: ProcedureTaskUpdate, opts: MutationOptions & { dryRun?: false }): Promise<ProcedureTask>;
  async update(id: number, data: ProcedureTaskUpdate, opts: MutationOptions | undefined): Promise<ProcedureTask | DryRunResult<ProcedureTask>>;
  async update(id: number, data: ProcedureTaskUpdate, opts?: MutationOptions): Promise<ProcedureTask | DryRunResult<ProcedureTask>> {
    // Live-verified on Hudu 2.45.1 (2026-09-12): a created procedure task and its GET response
    // carry NO `created_at`/`updated_at` (observed keys end at name, url, completed_date,
    // due_date, formatted_due_date, priority, completion_notes, assigned_users,
    // first_assigned_user_*, user_id, user_name, description, position, completed,
    // procedure_id, optional, parent_task_id, subtask_ids, subtask_count, has_subtasks). No
    // revision therefore exists to compare, so this row's `staleCheck` is "unavailable" and the
    // opt-in guard is REFUSED by name before any request. STALE_OBJECT is unreachable here and
    // the registry no longer advertises it.
    if (opts?.expectedUpdatedAt !== undefined) {
      throw new HuduConfigError(
        'procedure_tasks.update cannot honour { expectedUpdatedAt }: the live vendor record carries no ' +
          'updated_at field, so there is no revision to compare. Omit the guard, or use { dryRun: true } to preview the change.',
      );
    }
    return this.updateOne<ProcedureTask>(id, data, undefined, opts);
  }

  /** DELETE /procedure_tasks/{id}. */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  /** Live delete. A delete is bounded by an explicit id and Hudu exposes no conditional delete. */
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    // staleCheck is "unavailable" for a delete: there is no prior revision to compare and
    // the vendor declares no conditional delete, so `expectedUpdatedAt` is refused here.
    refuseExpectedUpdatedAtOutsideUpdate('procedure_tasks.delete', opts);
    // The spec's 200 response body is not guaranteed to be present; return void
    // so an empty body (undefined) is never mis-typed as `{ message }` (R4).
    return this.deleteOne(id, opts);
  }

  listPages(params?: ProcedureTasksListParams): AsyncIterable<Page<ProcedureTask>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §5/§6/§9).
  // ---------------------------------------------------------------------------

  /** Resolve a procedure task from an id or an exact name; default returns `ProcedureTaskSummary`. */
  async resolve(identifier: Identifier): Promise<ProcedureTaskSummary | null>;
  /** `{ expand: true }` returns the full task record. */
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<ProcedureTask | null>;
  /** `{ resolutionDetails: true }` returns the resolution cost/scan/candidates. */
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<ProcedureTaskSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<ProcedureTaskSummary | ProcedureTask | null | Resolution<ProcedureTaskSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<ProcedureTaskSummary | ProcedureTask | null | Resolution<ProcedureTaskSummary>> {
    const resolution = await this.resolveTask(identifier, opts);
    if (opts?.resolutionDetails === true) {
      const value = resolution.value;
      return { ...resolution, value: value === null ? null : toProcedureTaskSummary(value) };
    }
    const record = resolution.value;
    if (record === null) return null;
    return opts?.expand === true ? record : toProcedureTaskSummary(record);
  }

  /** Kind dispatch for `resolve`: numeric id, then an exact name (policy §6). */
  private async resolveTask(identifier: Identifier, opts?: ResolutionOptions): Promise<Resolution<ProcedureTask>> {
    const method = 'procedure_tasks.resolve';
    const limit = helperLimit(opts?.limit, method);
    if (typeof identifier === 'number') {
      return this.taskById(requirePositiveId(identifier, method));
    }
    if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (text.length === 0) throw identifierError(method, 'a non-empty id or name');
      if (/^\d+$/.test(text)) return this.taskById(requirePositiveId(Number(text), method));
      return this.taskByName(text, {}, limit);
    }
    if (identifier !== null && typeof identifier === 'object') {
      const { id, name, procedure_id, company_id } = identifier as {
        id?: number; name?: string; procedure_id?: number; company_id?: number;
      };
      if (id !== undefined) return this.taskById(requirePositiveId(id, method));
      if (typeof name === 'string' && name.trim().length > 0) {
        const filter: { procedure_id?: number; company_id?: number } = {};
        if (procedure_id !== undefined) filter.procedure_id = procedure_id;
        if (company_id !== undefined) filter.company_id = company_id;
        return this.taskByName(name.trim(), filter, limit);
      }
    }
    throw identifierError(method, 'an id or a name (narrowed with procedure_id or company_id)');
  }

  /** `GET /procedure_tasks/{id}` — a miss is NOT_FOUND (never null, policy §6). */
  private async taskById(id: number): Promise<Resolution<ProcedureTask>> {
    const record = await this.getOne<ProcedureTask>(id);
    return {
      value: record,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: record.id, label: record.name }],
    };
  }

  /**
   * Exact-name lookup through the vendor `name` filter. `GET /procedure_tasks` is
   * NON-paginated, so one fetch returns the whole collection and nothing is left
   * unread: a complete-scan miss is a definitive `null`.
   */
  private async taskByName(
    name: string,
    extra: { procedure_id?: number; company_id?: number },
    limit: number,
  ): Promise<Resolution<ProcedureTask>> {
    const filter: ListParams = { name, ...extra };
    const matches: ProcedureTask[] = [];
    const scan = await this.boundedScan<ProcedureTask>(this.pageFetcher(filter), {
      match: (record) => {
        if (record.name === name) matches.push(record);
        return matches.length >= limit;
      },
      label: (record) => record.name,
      idOf: (record) => record.id,
      resolutionCost: 'server-filter',
    });
    return decideResolution<ProcedureTask>({
      operation: 'procedure_tasks.resolve',
      resource: 'procedure_tasks',
      identifier: name,
      matches,
      scanned: scan.scanned,
      truncated: scan.scanTruncated,
      resolutionCost: 'server-filter',
      label: (record) => record.name,
      idOf: (record) => record.id,
    });
  }
}
