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
  list(params?: ActivityLogsListParams): AsyncIterable<ActivityLog> {
    return this.items(params ?? {});
  }
  async listAll(params?: ActivityLogsListParams): Promise<ActivityLog[]> {
    return this.all(params ?? {});
  }
  listPages(params?: ActivityLogsListParams): AsyncIterable<Page<ActivityLog>> {
    return this.pageIter(params ?? {});
  }
  /** DELETE /activity_logs — deletes ALL activity logs. Caller beware. */
  async deleteAll(): Promise<void> {
    await this.http.request<unknown>({ method: 'DELETE', path: '/activity_logs' });
  }
}
