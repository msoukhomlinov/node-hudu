/**
 * ProceduresResource — Hudu "procedures" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type {
  DryRunResult, Identifier, MutationOptions, Resolution, ResolutionOptions,
} from '../types/common.js';
import type { Procedure, ProcedureCreate, ProcedureTask, ProcedureUpdate } from '../types/index.js';
import type {
  ProcedureSummary, ProcedureWithTasks, ProcedureWithTasksFull,
} from '../types/procedure.js';
import { ProcedureTasksResource, toProcedureTaskSummary } from './procedure_tasks.js';
import {
  decideResolution, helperLimit, identifierError, numericIds, requirePositiveId,
} from './agent-layer-helpers.js';

export interface ProceduresListParams extends ListParams {
  type?: string;
  process_scope?: string;
  parent_process_id?: number;
  name?: string;
  company_id?: number;
  slug?: string;
  created_at?: string;
  updated_at?: string;
  archived?: string;
  global_template?: string;
  company_template?: number;
  parent_procedure_id?: number;
}

/** Options accepted by `getWithTasks` (the task list is bounded by `limit`). */
export interface GetWithTasksOptions {
  /** Task bound: default 25, hard maximum 100. */
  limit?: number;
  /** Return the full procedure and its full task records instead of the summaries. */
  expand?: boolean;
}

/** Compact projection of one procedure (policy §9). */
export function toProcedureSummary(record: Procedure): ProcedureSummary {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    company_id: record.company_id,
    company_name: record.company_name,
    status: record.status,
    total: record.total,
    completed: record.completed,
    completion_percentage: record.completion_percentage,
    process_type: record.process_type,
    url: record.url,
    updated_at: record.updated_at,
  };
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

  /** POST /procedures. */
  async create(data: ProcedureCreate): Promise<Procedure>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: ProcedureCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Procedure>>;
  /** Live create; `expectedUpdatedAt` has no meaning for a record that does not exist yet. */
  async create(data: ProcedureCreate, opts: MutationOptions & { dryRun?: false }): Promise<Procedure>;
  async create(data: ProcedureCreate, opts: MutationOptions | undefined): Promise<Procedure | DryRunResult<Procedure>>;
  async create(data: ProcedureCreate, opts?: MutationOptions): Promise<Procedure | DryRunResult<Procedure>> {
    // The stale guard is a read-then-compare on an EXISTING revision; a create has none,
    // so `MutationOptions` is passed through and `expectedUpdatedAt` is a no-op here
    // (base.ts documents the guard as update-only).
    return this.createOne<Procedure>(data, undefined, opts);
  }

  /** PUT /procedures/{id}. */
  async update(id: number, data: ProcedureUpdate): Promise<Procedure>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: ProcedureUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Procedure>>;
  /** Live update; `{ expectedUpdatedAt }` adds the opt-in stale guard. */
  async update(id: number, data: ProcedureUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Procedure>;
  async update(id: number, data: ProcedureUpdate, opts: MutationOptions | undefined): Promise<Procedure | DryRunResult<Procedure>>;
  async update(id: number, data: ProcedureUpdate, opts?: MutationOptions): Promise<Procedure | DryRunResult<Procedure>> {
    return this.updateOne<Procedure>(id, data, undefined, opts);
  }

  /** DELETE /procedures/{id}. */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  /** Live delete. A delete is bounded by an explicit id and Hudu exposes no conditional delete. */
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    // staleCheck is "unavailable" for a delete (no prior revision to compare, no
    // conditional delete in the vendor API), so `expectedUpdatedAt` is not consulted here.
    // The spec's 200 response body is not guaranteed to be present; return void
    // so an empty body (undefined) is never mis-typed as `{ message }` (R4).
    return this.deleteOne(id, opts);
  }

  listPages(params?: ProceduresListParams): AsyncIterable<Page<Procedure>> {
    return this.pageIter(params ?? {});
  }

  /** POST /procedures/{id}/duplicate — create a copy of a process. */
  async duplicate(id: number, opts: { company_id: number; name?: string; description?: string }): Promise<Procedure>;
  /** Dry-run: describe the duplicate without issuing it. */
  async duplicate(
    id: number,
    opts: { company_id: number; name?: string; description?: string },
    options: MutationOptions & { dryRun: true },
  ): Promise<DryRunResult<Procedure>>;
  async duplicate(
    id: number,
    opts: { company_id: number; name?: string; description?: string },
    options: MutationOptions | undefined,
  ): Promise<Procedure | DryRunResult<Procedure>>;
  async duplicate(
    id: number,
    opts: { company_id: number; name?: string; description?: string },
    options?: MutationOptions,
  ): Promise<Procedure | DryRunResult<Procedure>> {
    const operation = 'procedures.duplicate';
    if (options?.dryRun === true) {
      return this.buildDryRunResult<Procedure>({
        operation,
        method: 'POST',
        path: `/procedures/${id}/duplicate`,
        ids: numericIds(id),
        checks: [this.targetCheck(id), this.companyBoundCheck(opts.company_id)],
        affected: 1,
        scope: 'single',
        reversible: true,
      });
    }
    const body = await this.http.request<unknown>({
      method: 'POST',
      path: `/procedures/${id}/duplicate`,
      query: opts,
      operation,
      resourceIds: numericIds(id),
    });
    return this.unwrapSingle<Procedure>(body);
  }

  /** POST /procedures/{id}/create_from_template — copy a global template into a process. */
  async createFromTemplate(
    id: number,
    opts?: { company_id?: number; name?: string; description?: string },
  ): Promise<Procedure>;
  /** Dry-run: describe the template copy without issuing it. */
  async createFromTemplate(
    id: number,
    opts: { company_id?: number; name?: string; description?: string } | undefined,
    options: MutationOptions & { dryRun: true },
  ): Promise<DryRunResult<Procedure>>;
  async createFromTemplate(
    id: number,
    opts: { company_id?: number; name?: string; description?: string } | undefined,
    options: MutationOptions | undefined,
  ): Promise<Procedure | DryRunResult<Procedure>>;
  async createFromTemplate(
    id: number,
    opts?: { company_id?: number; name?: string; description?: string },
    options?: MutationOptions,
  ): Promise<Procedure | DryRunResult<Procedure>> {
    const operation = 'procedures.createFromTemplate';
    if (options?.dryRun === true) {
      return this.buildDryRunResult<Procedure>({
        operation,
        method: 'POST',
        path: `/procedures/${id}/create_from_template`,
        ids: numericIds(id),
        checks: [this.targetCheck(id)],
        affected: 1,
        scope: 'single',
        reversible: true,
      });
    }
    const body = await this.http.request<unknown>({
      method: 'POST',
      path: `/procedures/${id}/create_from_template`,
      query: opts,
      operation,
      resourceIds: numericIds(id),
    });
    return this.unwrapSingle<Procedure>(body);
  }

  /** POST /procedures/{id}/kickoff — start a run of a process. */
  async kickoff(id: number, opts?: { asset_id?: number; name?: string }): Promise<{ message: string }>;
  /** Dry-run: describe the run start without issuing it. */
  async kickoff(
    id: number,
    opts: { asset_id?: number; name?: string } | undefined,
    options: MutationOptions & { dryRun: true },
  ): Promise<DryRunResult<{ message: string }>>;
  async kickoff(
    id: number,
    opts: { asset_id?: number; name?: string } | undefined,
    options: MutationOptions | undefined,
  ): Promise<{ message: string } | DryRunResult<{ message: string }>>;
  async kickoff(
    id: number,
    opts?: { asset_id?: number; name?: string },
    options?: MutationOptions,
  ): Promise<{ message: string } | DryRunResult<{ message: string }>> {
    const operation = 'procedures.kickoff';
    if (options?.dryRun === true) {
      // kickoff returns { message } — NOT a Procedure — so the dry-run pins that type.
      return this.buildDryRunResult<{ message: string }>({
        operation,
        method: 'POST',
        path: `/procedures/${id}/kickoff`,
        ids: numericIds(id),
        checks: [this.targetCheck(id)],
        affected: 1,
        scope: 'single',
        reversible: true,
      });
    }
    return this.http.request<{ message: string }>({
      method: 'POST',
      path: `/procedures/${id}/kickoff`,
      query: opts,
      operation,
      resourceIds: numericIds(id),
    });
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §5/§6/§9).
  // ---------------------------------------------------------------------------

  /** Resolve a procedure from an id, slug or exact name; default returns `ProcedureSummary`. */
  async resolve(identifier: Identifier): Promise<ProcedureSummary | null>;
  /** `{ expand: true }` returns the full procedure. */
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<Procedure | null>;
  /** `{ resolutionDetails: true }` returns the resolution cost/scan/candidates. */
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<ProcedureSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<ProcedureSummary | Procedure | null | Resolution<ProcedureSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<ProcedureSummary | Procedure | null | Resolution<ProcedureSummary>> {
    const resolution = await this.resolveProcedure(identifier, opts);
    if (opts?.resolutionDetails === true) {
      const value = resolution.value;
      return { ...resolution, value: value === null ? null : toProcedureSummary(value) };
    }
    const record = resolution.value;
    if (record === null) return null;
    return opts?.expand === true ? record : toProcedureSummary(record);
  }

  /**
   * Fetch a procedure together with its tasks in one call (the group's composite helper).
   *
   * Combines `GET /procedures/{id}` with `GET /procedure_tasks?procedure_id={id}` — a
   * NON-paginated endpoint — so an agent does not have to know the tasks live in another
   * resource. The task list is bounded by `limit` (default 25, hard maximum 100); the
   * compact result carries `task_count`, so `tasks.length < task_count` means the bound
   * cut the list short.
   */
  async getWithTasks(id: number, opts?: GetWithTasksOptions): Promise<ProcedureWithTasks>;
  async getWithTasks(id: number, opts: { limit?: number; expand: true }): Promise<ProcedureWithTasksFull>;
  async getWithTasks(id: number, opts?: GetWithTasksOptions): Promise<ProcedureWithTasks | ProcedureWithTasksFull>;
  async getWithTasks(id: number, opts?: GetWithTasksOptions): Promise<ProcedureWithTasks | ProcedureWithTasksFull> {
    const method = 'procedures.getWithTasks';
    const procedureId = requirePositiveId(id, method);
    const limit = helperLimit(opts?.limit, method);
    // The sibling resource is built from the SAME HttpClient: no client coupling.
    const procedure = await this.get(procedureId);
    const tasksResource = new ProcedureTasksResource(this.http);
    const tasks: ProcedureTask[] = [];
    for await (const task of tasksResource.list({ procedure_id: procedureId })) {
      tasks.push(task);
      if (tasks.length >= limit) break;
    }
    if (opts?.expand === true) {
      return { procedure, tasks, task_count: tasks.length, limit };
    }
    return {
      procedure: toProcedureSummary(procedure),
      tasks: tasks.map(toProcedureTaskSummary),
      task_count: tasks.length,
    };
  }

  /** Dry-run check: the vendor requires an explicit company for a duplicate. */
  private companyBoundCheck(companyId: number | undefined): { name: string; ok: boolean; detail: string } {
    const ok = typeof companyId === 'number' && Number.isInteger(companyId) && companyId > 0;
    return {
      name: 'company-bound',
      ok,
      detail: ok ? `target company ${String(companyId)}` : 'duplicate requires a positive company_id',
    };
  }

  /** One bounded exact-match lookup for a slug or a name (server-filter basis). */
  private async procedureByField(
    field: 'slug' | 'name',
    value: string,
    companyId: number | undefined,
    limit: number,
  ): Promise<Resolution<Procedure>> {
    const filter: ListParams = {};
    filter[field] = value;
    if (companyId !== undefined) filter.company_id = companyId;
    const matches: Procedure[] = [];
    const scan = await this.boundedScan<Procedure>(this.pageFetcher(filter), {
      match: (record) => {
        if (record[field] === value) matches.push(record);
        return matches.length >= limit;
      },
      label: (record) => record.name,
      idOf: (record) => record.id,
      resolutionCost: 'server-filter',
    });
    return decideResolution<Procedure>({
      operation: 'procedures.resolve',
      resource: 'procedures',
      identifier: value,
      matches,
      scanned: scan.scanned,
      truncated: scan.scanTruncated,
      resolutionCost: 'server-filter',
      label: (record) => record.name,
      idOf: (record) => record.id,
    });
  }

  /** `GET /procedures/{id}` — a miss is NOT_FOUND (never null, policy §6). */
  private async procedureById(id: number): Promise<Resolution<Procedure>> {
    const record = await this.getOne<Procedure>(id);
    return {
      value: record,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: record.id, label: record.name }],
    };
  }

  /** Kind dispatch for `resolve`: numeric id, slug, then exact name (policy §6). */
  private async resolveProcedure(identifier: Identifier, opts?: ResolutionOptions): Promise<Resolution<Procedure>> {
    const method = 'procedures.resolve';
    const limit = helperLimit(opts?.limit, method);
    if (typeof identifier === 'number') return this.procedureById(requirePositiveId(identifier, method));
    if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (text.length === 0) throw identifierError(method, 'a non-empty id, slug or name');
      if (/^\d+$/.test(text)) return this.procedureById(requirePositiveId(Number(text), method));
      // Policy order for a bare value: numeric id -> slug -> exact name.
      const bySlug = await this.procedureByField('slug', text, undefined, limit);
      if (bySlug.value !== null) return bySlug;
      return this.procedureByField('name', text, undefined, limit);
    }
    if (identifier !== null && typeof identifier === 'object') {
      const { id, slug, name, company_id } = identifier as {
        id?: number; slug?: string; name?: string; company_id?: number;
      };
      if (id !== undefined) return this.procedureById(requirePositiveId(id, method));
      if (typeof slug === 'string' && slug.trim().length > 0) {
        return this.procedureByField('slug', slug.trim(), undefined, limit);
      }
      if (typeof name === 'string' && name.trim().length > 0) {
        return this.procedureByField('name', name.trim(), company_id, limit);
      }
    }
    throw identifierError(method, 'an id, a slug or a name (with an optional company_id)');
  }
}
