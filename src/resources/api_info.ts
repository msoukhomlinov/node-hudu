/**
 * ApiInfoResource — Hudu "api_info" resource.
 *
 * `GET /api_info` is a SINGLETON document (version + date) with no identifier, so
 * `resolve` is the documented degenerate case: it ignores the identifier, performs
 * exactly one bounded read and returns the singleton. That keeps the SDK's
 * "resolve everywhere" floor true without inventing a lookup the vendor cannot support.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { HelperOptions, Identifier, Resolution } from '../types/common.js';
import type { ApiInfo } from '../types/index.js';

export class ApiInfoResource extends BaseResource<ApiInfo> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'api_info', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /** GET /api_info — API version and date. */
  async get(): Promise<ApiInfo> {
    return this.http.request<ApiInfo>({ method: 'GET', path: '/api_info', operation: 'api_info.get' });
  }

  /**
   * DEGENERATE CASE, documented deliberately (SCOPING decision 14): the identifier is
   * ignored, because the vendor has no lookup for this singleton — unsupported kinds are
   * ignored, not thrown on. Exactly ONE request is issued.
   */
  async resolve(identifier?: Identifier, opts?: HelperOptions): Promise<ApiInfo>;
  /** `{ resolutionDetails: true }` returns the singleton inside a `Resolution<ApiInfo>`. */
  async resolve(identifier: Identifier | undefined, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<ApiInfo>>;
  async resolve(
    _identifier?: Identifier,
    opts?: HelperOptions,
  ): Promise<ApiInfo | Resolution<ApiInfo>> {
    // `limit`/`expand` carry no meaning for a singleton and are accepted, then ignored.
    const value = await this.get();
    if (opts?.resolutionDetails === true) {
      return { value, resolutionCost: 'direct', scanned: 1, scanTruncated: false };
    }
    return value;
  }
}
