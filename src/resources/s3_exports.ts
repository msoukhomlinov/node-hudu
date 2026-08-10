/**
 * S3ExportsResource — Hudu "s3_exports" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { S3ExportCreate } from '../types/index.js';

export class S3ExportsResource extends BaseResource<unknown> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 's3_exports', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }
  /** POST /s3_exports — initiate an s3 export. Returns 200 with empty (null) body. */
  async create(data?: S3ExportCreate): Promise<void> {
    await this.http.request<unknown>({ method: 'POST', path: '/s3_exports', body: data ?? {} });
  }
}
