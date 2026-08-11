/**
 * ActivityLogsResource — Hudu "activity_logs" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { ActivityLog } from '../types/index.js';

export interface ActivityLogsListParams extends ListParams {
  user_id?: number;
  user_email?: string;
  resource_id?: number;
  resource_type?: string;
  action_message?: string;
  start_date?: string;
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
  /** DELETE /activity_logs — deletes ALL activity logs from a given datetime. Caller beware. */
  async deleteAll(params: { datetime: string; delete_unassigned_logs?: boolean }): Promise<void> {
    await this.http.request<unknown>({
      method: 'DELETE',
      path: '/activity_logs',
      query: { datetime: params.datetime, delete_unassigned_logs: params.delete_unassigned_logs },
    });
  }
}
