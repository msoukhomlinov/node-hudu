/**
 * ApiInfoResource — Hudu "api_info" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ApiInfo } from '../types/index.js';

export class ApiInfoResource extends BaseResource<ApiInfo> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'api_info', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }
  /** GET /api_info — API version and date. */
  async get(): Promise<ApiInfo> {
    return this.http.request<ApiInfo>({ method: 'GET', path: '/api_info' });
  }
}
