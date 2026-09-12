/**
 * ActivityLogsResource — Hudu "activity_logs" resource.
 *
 * Hudu exposes no `GET /activity_logs/{id}`, so `resolve` is a bounded client scan
 * (policy §6) and the DELETE is a bulk delete from a datetime on, which the SDK refuses
 * to run without a bound (`POLICY_DENIED`).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import { PolicyDeniedError } from '../errors.js';
import type { ListParams, Page } from '../pagination.js';
import type {
  DryRunResult, Identifier, MutationOptions, OperationImpact, Resolution, ResolutionOptions,
} from '../types/common.js';
import type { ActivityLog } from '../types/index.js';
import type { ActivityLogIdentifier, ActivityLogSummary } from '../types/activity_log.js';
import {
  MAX_HELPER_LIMIT, decideResolution, helperLimit, identifierError, refuseClientScan,
  refuseExpectedUpdatedAtOutsideUpdate,
} from './agent-layer-helpers.js';

export interface ActivityLogsListParams extends ListParams {
  user_id?: number;
  user_email?: string;
  resource_id?: number;
  resource_type?: string;
  action_message?: string;
  start_date?: string;
}

/** Options accepted by `findByResource`. */
export interface FindByResourceOptions {
  /** Row bound: default 25, hard maximum 100. */
  limit?: number;
  /** Only entries from this ISO-8601 instant on (vendor `start_date`). */
  startDate?: string;
  /** Return the full log records instead of the compact summaries. */
  expand?: boolean;
}

/**
 * Impact of an EXECUTED bulk delete whose target set the server computes: `affected: 1` is a
 * labelled LOWER BOUND (`exact: false` means "at least one record, the server decides the real
 * set"), and `scope: 'bulk'` states the shape. It is derived without an extra request so the
 * executed call keeps its one-request observable behaviour.
 */
const EXECUTED_BULK_DELETE_IMPACT: OperationImpact = {
  affected: 1,
  scope: 'bulk',
  reversible: false,
  exact: false,
};

/** Compact projection of one activity log (policy §9). */
export function toActivityLogSummary(record: ActivityLog): ActivityLogSummary {
  return {
    id: record.id,
    user_id: record.user_id,
    user_email: record.user_email,
    resource_id: record.resource_id,
    resource_type: record.resource_type,
    action_message: record.action_message,
    created_at: record.created_at,
  };
}

export class ActivityLogsResource extends BaseResource<ActivityLog> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'activity_logs', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /**
   * Tolerate either live 200 shape for GET /activity_logs: the api-docs spec
   * does NOT document the response envelope, and the live n8n node handles both
   * a bare array and a record wrapping `{ activity_logs: [...] }`. `listKey` is
   * intentionally undefined so base pagination routes the raw body through this
   * override, which normalises both shapes to the item array (B-1).
   */
  protected override unwrapList<U = ActivityLog>(data: unknown): U[] {
    if (Array.isArray(data)) return data as U[];
    if (data !== null && typeof data === 'object') {
      const wrapped = (data as Record<string, unknown>).activity_logs;
      if (Array.isArray(wrapped)) return wrapped as U[];
    }
    // undefined / null / or an unexpected record without an activity_logs array => no results.
    return [];
  }

  list(params?: ActivityLogsListParams): AsyncIterable<ActivityLog> {
    return this.items(params ?? {});
  }
  async listAll(params?: ActivityLogsListParams): Promise<ActivityLog[]> {
    return this.all(params ?? {});
  }
  listPages(params?: ActivityLogsListParams): AsyncIterable<Page<ActivityLog>> {
    return this.pageIter(params ?? {});
  }

  /**
   * DELETE /activity_logs — deletes EVERY activity log from `datetime` on.
   *
   * There is no narrower bulk delete, so the SDK refuses an unbounded call: a missing
   * or empty `datetime` (which would wipe the whole log) throws `POLICY_DENIED` before
   * any request, and `{ dryRun: true }` describes the bound without issuing the write.
   */
  async deleteAll(params: { datetime: string; delete_unassigned_logs?: boolean }): Promise<void>;
  /** Dry-run: describe the bulk delete without issuing it. */
  async deleteAll(
    params: { datetime: string; delete_unassigned_logs?: boolean },
    opts: MutationOptions & { dryRun: true },
  ): Promise<DryRunResult<void>>;
  async deleteAll(
    params: { datetime: string; delete_unassigned_logs?: boolean },
    opts: MutationOptions | undefined,
  ): Promise<void | DryRunResult<void>>;
  async deleteAll(
    params: { datetime: string; delete_unassigned_logs?: boolean },
    opts?: MutationOptions,
  ): Promise<void | DryRunResult<void>> {
    const operation = 'activity_logs.deleteAll';
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const datetime = typeof params?.datetime === 'string' ? params.datetime.trim() : '';
    const bound = `every activity log from ${datetime} on` +
      (params?.delete_unassigned_logs === true ? ' (including unassigned logs)' : '');
    if (datetime.length === 0) {
      throw new PolicyDeniedError(
        `${operation} refuses to run without a datetime bound: an empty datetime would delete the entire activity log.`,
        {
          operation,
          suggestedAction: 'Pass the ISO-8601 datetime the deletion should start at, or call with { dryRun: true } to inspect the impact first.',
        },
      );
    }
    if (opts?.dryRun === true) {
      // The affected set is server-computed, so a literal count would understate it: the dry-run
      // (which may spend a request, because it is a description, not a mutation) measures a FLOOR
      // with one bounded page read (page_size 100) of the read-side filter.
      const described = await this.deleteAllImpact(datetime);
      return this.buildDryRunResult<void>({
        operation,
        method: 'DELETE',
        path: '/activity_logs',
        checks: [{ name: 'bulk-bound', ok: true, detail: bound }],
        ...described,
        warnings: [
          `bulk delete by a server-side bound: ${bound}`,
          `affected ${described.affected} is a FLOOR from ONE bounded page (page_size ${MAX_HELPER_LIMIT}) read via ` +
            'start_date; the server decides the final target set',
        ],
      });
    }
    // The EXECUTED call keeps its observable shape: ONE request, the mutating one. It therefore
    // reports the same SHAPE and reversibility as the dry-run but a labelled lower bound for the
    // count (`affected: 1, exact: false` = "at least one record; the server computes the real
    // set"), instead of buying a pre-read that would change every existing caller's request count.
    await this.http.request<unknown>({
      method: 'DELETE',
      path: '/activity_logs',
      query: { datetime: params.datetime, delete_unassigned_logs: params.delete_unassigned_logs },
      operation,
      impact: EXECUTED_BULK_DELETE_IMPACT,
    });
  }

  /**
   * The impact of a bulk delete, for BOTH channels: `exact: false` marks `affected` as a floor
   * measured by one bounded page read (page_size 100) with the read-side filter, because the
   * real target set is computed by the server.
   */
  private async deleteAllImpact(datetime: string): Promise<OperationImpact> {
    const floor = await this.countFloor({ start_date: datetime });
    return { affected: floor, scope: 'bulk', reversible: false, exact: false };
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §5/§6/§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve an activity log entry by its id (the only kind the vendor can support).
   *
   * `GET /activity_logs` has no id filter and there is no `GET /activity_logs/{id}`, so
   * the id is found by a bounded client scan (500 records / 4 pages by default),
   * narrowable with `resource_type`/`resource_id`. A truncated scan throws
   * RESOLUTION_TRUNCATED instead of returning `null`.
   */
  async resolve(identifier: Identifier): Promise<ActivityLogSummary | null>;
  /** `{ expand: true }` returns the full log record. */
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<ActivityLog | null>;
  /** `{ resolutionDetails: true }` returns the resolution cost/scan/candidates. */
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<ActivityLogSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<ActivityLogSummary | ActivityLog | null | Resolution<ActivityLogSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<ActivityLogSummary | ActivityLog | null | Resolution<ActivityLogSummary>> {
    const resolution = await this.resolveLog(identifier, opts);
    if (opts?.resolutionDetails === true) {
      const value = resolution.value;
      return { ...resolution, value: value === null ? null : toActivityLogSummary(value) };
    }
    const record = resolution.value;
    if (record === null) return null;
    return opts?.expand === true ? record : toActivityLogSummary(record);
  }

  /**
   * List the activity log entries of one resource ("what happened to this record").
   * Uses the vendor `resource_id` + `resource_type` filters (optionally bounded by
   * `start_date`), so no scan is needed; the list is bounded by `limit`
   * (default 25, hard maximum 100).
   */
  async findByResource(resourceType: string, resourceId: number, opts?: FindByResourceOptions): Promise<ActivityLogSummary[]>;
  async findByResource(
    resourceType: string,
    resourceId: number,
    opts: FindByResourceOptions & { expand: true },
  ): Promise<ActivityLog[]>;
  async findByResource(
    resourceType: string,
    resourceId: number,
    opts?: FindByResourceOptions,
  ): Promise<ActivityLogSummary[] | ActivityLog[]>;
  async findByResource(
    resourceType: string,
    resourceId: number,
    opts?: FindByResourceOptions,
  ): Promise<ActivityLogSummary[] | ActivityLog[]> {
    const method = 'activity_logs.findByResource';
    const limit = helperLimit(opts?.limit, method);
    if (typeof resourceType !== 'string' || resourceType.trim().length === 0) {
      throw identifierError(method, 'a non-empty resource type (e.g. "Asset") and a positive resource id');
    }
    if (!Number.isInteger(resourceId) || resourceId < 1) {
      throw identifierError(method, 'a non-empty resource type (e.g. "Asset") and a positive resource id');
    }
    const filter: ListParams = { resource_type: resourceType.trim(), resource_id: resourceId };
    if (typeof opts?.startDate === 'string' && opts.startDate.length > 0) filter.start_date = opts.startDate;
    const logs = await this.collectBounded(filter, limit);
    const summaries = logs.map(toActivityLogSummary);
    return opts?.expand === true ? logs : summaries;
  }

  /**
   * One bounded page read (page_size 100) used as an `affected` FLOOR for a bulk dry-run.
   * It is a read only: the dry-run still issues no mutating request.
   */
  private async countFloor(filter: ListParams): Promise<number> {
    const page = await this.pageFetcher(filter)(1, MAX_HELPER_LIMIT);
    return page.items.length;
  }

  /** Collect at most `limit` rows through one bounded scan. */
  private async collectBounded(filter: ListParams, limit: number): Promise<ActivityLog[]> {
    const items: ActivityLog[] = [];
    await this.boundedScan<ActivityLog>(this.pageFetcher(filter), {
      match: (record) => {
        items.push(record);
        return items.length >= limit;
      },
      label: (record) => String(record.id ?? ''),
      idOf: (record) => record.id ?? 0,
      resolutionCost: 'server-filter',
    });
    return items.slice(0, limit);
  }

  /** Kind dispatch for `resolve`: an id, or a validation error naming what is accepted. */
  private async resolveLog(identifier: Identifier, opts?: ResolutionOptions): Promise<Resolution<ActivityLog>> {
    const method = 'activity_logs.resolve';
    // `limit` is validated even though an id is unique: an out-of-range limit is a caller
    // bug everywhere else in the helper tier, so it must not pass silently here.
    helperLimit(opts?.limit, method);
    let id: number | undefined;
    const filter: ListParams = {};
    if (typeof identifier === 'number') {
      id = identifier;
    } else if (typeof identifier === 'string') {
      if (/^\d+$/.test(identifier.trim())) id = Number(identifier.trim());
    } else if (identifier !== null && typeof identifier === 'object') {
      const typed = identifier as ActivityLogIdentifier;
      if (typed.id !== undefined) id = typed.id;
      if (typeof typed.resource_type === 'string' && typed.resource_type.length > 0) {
        filter.resource_type = typed.resource_type;
      }
      if (typeof typed.resource_id === 'number') filter.resource_id = typed.resource_id;
    }
    if (id === undefined || !Number.isInteger(id) || id < 1) {
      throw identifierError(method, 'a numeric id (optionally narrowed with resource_type/resource_id)');
    }
    if (opts?.allowClientScan === false) refuseClientScan(method, 'activity_logs', identifier);
    const matches: ActivityLog[] = [];
    const scan = await this.boundedScan<ActivityLog>(this.pageFetcher(filter), {
      // An id is unique, so the first match decides and the scan stops there.
      match: (record) => {
        if (record.id === id) matches.push(record);
        return matches.length >= 1;
      },
      label: (record) => String(record.id ?? ''),
      idOf: (record) => record.id ?? 0,
      resolutionCost: 'client-scan',
    });
    return decideResolution<ActivityLog>({
      operation: method,
      resource: 'activity_logs',
      identifier,
      matches,
      scanned: scan.scanned,
      truncated: scan.scanTruncated,
      resolutionCost: 'client-scan',
      label: (record) => String(record.id ?? ''),
      idOf: (record) => record.id ?? 0,
      // An id names ONE record: a complete scan that finds nothing is NOT_FOUND, never null.
      definite: true,
    });
  }
}
