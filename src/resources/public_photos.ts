/**
 * PublicPhotosResource — Hudu "public_photos" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { PublicPhoto, PublicPhotoCreate, PublicPhotoUpdate } from '../types/index.js';

export type PublicPhotosListParams = ListParams;

export class PublicPhotosResource extends BaseResource<PublicPhoto> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'public_photos', singleKey: 'public_photo', listKey: 'public_photos', createType: 'raw', paginated: true });
  }
  async get(id: number, opts?: { download?: boolean }): Promise<PublicPhoto | Blob> {
    if (opts?.download) {
      return this.http.download({ method: 'GET', path: `/public_photos/${id}`, query: { download: true } });
    }
    return this.getOne<PublicPhoto>(id);
  }
  list(params?: PublicPhotosListParams): AsyncIterable<PublicPhoto> {
    return this.items(params ?? {});
  }
  async listAll(params?: PublicPhotosListParams): Promise<PublicPhoto[]> {
    return this.all(params ?? {});
  }
  listPages(params?: PublicPhotosListParams): AsyncIterable<Page<PublicPhoto>> {
    return this.pageIter(params ?? {});
  }
  /** Multipart create: photo + required record_type + record_id. */
  async create(data: PublicPhotoCreate): Promise<PublicPhoto> {
    const fd = new FormData();
    fd.append('photo', data.photo as Blob);
    fd.append('record_type', data.record_type);
    fd.append('record_id', String(data.record_id));
    const body = await this.http.request<unknown>({ method: 'POST', path: '/public_photos', formData: fd });
    return body as PublicPhoto;
  }
  /** PUT consumes multipart/form-data and returns a { public_photo } envelope. */
  async update(id: number, data: PublicPhotoUpdate): Promise<PublicPhoto> {
    const fd = new FormData();
    fd.append('record_type', data.record_type);
    fd.append('record_id', String(data.record_id));
    const body = await this.http.request<unknown>({ method: 'PUT', path: `/public_photos/${id}`, formData: fd });
    return this.unwrapSingle<PublicPhoto>(body);
  }
}
