/**
 * MagicDashResource — Hudu "magic_dash" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { MagicDash, MagicDashCreate } from '../types/index.js';

export interface MagicDashListParams extends ListParams {
  title?: string;
  company_id?: number;
}

export class MagicDashResource extends BaseResource<MagicDash> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'magic_dash', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  list(params?: MagicDashListParams): AsyncIterable<MagicDash> {
    return this.items(params ?? {});
  }
  async listAll(params?: MagicDashListParams): Promise<MagicDash[]> {
    return this.all(params ?? {});
  }
  listPages(params?: MagicDashListParams): AsyncIterable<Page<MagicDash>> {
    return this.pageIter(params ?? {});
  }
  /** POST /magic_dash — may create or update. */
  async create(data: MagicDashCreate): Promise<MagicDash> {
    return this.createOne<MagicDash>(data);
  }
  /** DELETE /magic_dash (delete item without id). */
  async delete(): Promise<void> {
    await this.http.request<unknown>({ method: 'DELETE', path: '/magic_dash' });
  }
  /** DELETE /magic_dash/{id} */
  async deleteById(id: number): Promise<void> {
    await this.http.request<unknown>({ method: 'DELETE', path: `/magic_dash/${id}` });
  }
  /** PUT /magic_dash/update_positions */
  async updatePositions(data: { items: Array<{ id: number; position: number }> }): Promise<{ success: boolean }> {
    return this.http.request<{ success: boolean }>({ method: 'PUT', path: '/magic_dash/update_positions', body: data });
  }
}
