/**
 * ExpirationsResource — Hudu "expirations" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Expiration, ExpirationUpdate } from '../types/index.js';

export interface ExpirationsListParams extends ListParams {
  company_id?: number;
  expiration_type?: string;
  resource_id?: number;
  resource_type?: string;
  archived?: boolean;
}

export class ExpirationsResource extends BaseResource<Expiration> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'expirations', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /** Stream expirations across pages. */
  list(params?: ExpirationsListParams): AsyncIterable<Expiration> {
    return this.items(params ?? {});
  }
  /** Get every expirations. MCP-preferred read. */
  async listAll(params?: ExpirationsListParams): Promise<Expiration[]> {
    return this.all(params ?? {});
  }
  async update(id: number, data: ExpirationUpdate): Promise<Expiration> {
    return this.updateOne<Expiration>(id, { expiration: data });
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }

  listPages(params?: ExpirationsListParams): AsyncIterable<Page<Expiration>> {
    return this.pageIter(params ?? {});
  }


}
