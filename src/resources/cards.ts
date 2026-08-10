/**
 * CardsResource — Hudu integrator cards (lookup/jump).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { IntegratorCard } from '../types/index.js';

export class CardsResource extends BaseResource<unknown> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'cards', singleKey: undefined, listKey: 'integrator_cards', createType: 'raw', paginated: false });
  }
  /** GET /cards/lookup — returns { integrator_cards: [...] }. */
  async lookup(params: { integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<IntegratorCard[]> {
    const body = await this.http.request<unknown>({ method: 'GET', path: '/cards/lookup', query: params });
    return this.unwrapList<IntegratorCard>(body);
  }
  /** GET /cards/jump — follows the redirect and returns the final URL. */
  async jump(params: { integration_type: string; integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<string> {
    return this.followRedirect('/cards/jump', params as unknown as Record<string, unknown>);
  }
}
