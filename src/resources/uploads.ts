/**
 * UploadsResource — Hudu "uploads" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Upload } from '../types/index.js';

export interface UploadsListParams extends ListParams {}

export class UploadsResource extends BaseResource<Upload> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'uploads', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }
  list(params?: UploadsListParams): AsyncIterable<Upload> {
    return this.items(params ?? {});
  }
  async listAll(params?: UploadsListParams): Promise<Upload[]> {
    return this.all(params ?? {});
  }
  listPages(params?: UploadsListParams): AsyncIterable<Page<Upload>> {
    return this.pageIter(params ?? {});
  }
  /** Multipart upload. */
  async upload(file: File | Blob | Buffer, data: { uploadable_id: number; uploadable_type: string }): Promise<Upload> {
    const fd = new FormData();
    fd.append('file', file as Blob);
    fd.append('uploadable_id', String(data.uploadable_id));
    fd.append('uploadable_type', data.uploadable_type);
    const body = await this.http.request<unknown>({ method: 'POST', path: '/uploads', formData: fd });
    return body as Upload;
  }
  async get(id: number, opts?: { download?: boolean }): Promise<Upload | Blob> {
    if (opts?.download) {
      return this.http.request<Blob>({ method: 'GET', path: `/uploads/${id}`, query: { download: true } });
    }
    return this.getOne<Upload>(id);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }
}
