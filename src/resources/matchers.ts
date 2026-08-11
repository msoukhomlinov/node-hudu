/**
 * MatchersResource — Hudu "matchers" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Matcher, MatcherUpdate } from '../types/index.js';

export interface MatchersListParams extends ListParams {
  /** Required by the spec — the ID of the integration. */
  integration_id: number;
  matched?: boolean;
  sync_id?: number;
  identifier?: string;
  company_id?: number;
}

export class MatchersResource extends BaseResource<Matcher> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'matchers', singleKey: undefined, listKey: 'matchers', createType: 'raw', paginated: true });
  }

  /** Stream matchers across pages. integration_id is required (spec). */
  list(params: MatchersListParams): AsyncIterable<Matcher> {
    return this.items(params);
  }
  /** Get every matchers. MCP-preferred read. integration_id is required (spec). */
  async listAll(params: MatchersListParams): Promise<Matcher[]> {
    return this.all(params);
  }
  async update(id: number, data: MatcherUpdate): Promise<Matcher> {
    return this.updateOne<Matcher>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  /** Iterate matcher pages. integration_id is required (spec). */
  listPages(params: MatchersListParams): AsyncIterable<Page<Matcher>> {
    return this.pageIter(params);
  }


}
