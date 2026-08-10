/**
 * PublicPhotosResource — Hudu "public_photos" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { PublicPhoto, PublicPhotoCreate, PublicPhotoUpdate } from '../types/index.js';

export interface PublicPhotosListParams extends ListParams {}

export class PublicPhotosResource extends BaseResource<PublicPhoto> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'public_photos', singleKey: undefined, listKey: 'public_photos', createType: 'raw', paginated: true });
  }
  async get(id: number): Promise<PublicPhoto> {
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
  /** Multipart create: file + record_type? + record_id? */
  async create(data: PublicPhotoCreate): Promise<PublicPhoto> {
    const fd = new FormData();
    const rec = data as unknown as Record<string, unknown>;
    if (rec.file) fd.append('file', rec.file as Blob);
    if (rec.record_type !== undefined) fd.append('record_type', String(rec.record_type));
    if (rec.record_id !== undefined) fd.append('record_id', String(rec.record_id));
    const body = await this.http.request<unknown>({ method: 'POST', path: '/public_photos', formData: fd });
    return body as PublicPhoto;
  }
  async update(id: number, data: PublicPhotoUpdate): Promise<PublicPhoto> {
    const body = await this.http.request<unknown>({ method: 'PUT', path: `/public_photos/${id}`, body: data });
    return body as PublicPhoto;
  }
}
