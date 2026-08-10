/**
 * PhotosResource — Hudu "photos" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Photo } from '../types/index.js';

export interface PhotosListParams extends ListParams {
  company_id?: number;
  photoable_type?: string;
  photoable_id?: number;
  folder_id?: number;
  archived?: boolean;
  created_at?: string;
  updated_at?: string;
}

export class PhotosResource extends BaseResource<Photo> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'photos', singleKey: 'photo', listKey: 'photos', createType: 'wrapped', paginated: true });
  }
  async get(id: number, opts?: { download?: boolean }): Promise<Photo | Blob> {
    if (opts?.download) {
      return this.http.request<Blob>({ method: 'GET', path: `/photos/${id}`, query: { download: true } });
    }
    return this.getOne<Photo>(id);
  }
  list(params?: PhotosListParams): AsyncIterable<Photo> {
    return this.items(params ?? {});
  }
  async listAll(params?: PhotosListParams): Promise<Photo[]> {
    return this.all(params ?? {});
  }
  listPages(params?: PhotosListParams): AsyncIterable<Page<Photo>> {
    return this.pageIter(params ?? {});
  }
  /** Multipart create. */
  async create(data: Record<string, unknown>): Promise<Photo> {
    const fd = new FormData();
    if (data.file) fd.append('file', data.file as Blob);
    for (const k of ['caption','company_id','photoable_type','photoable_id','folder_id','pinned']) {
      const v = data[k];
      if (v !== undefined) fd.append(k, String(v));
    }
    const body = await this.http.request<unknown>({ method: 'POST', path: '/photos', formData: fd });
    return this.unwrapSingle<Photo>(body);
  }
  async update(id: number, data: Record<string, unknown>): Promise<Photo> {
    return this.updateOne<Photo>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }
}
