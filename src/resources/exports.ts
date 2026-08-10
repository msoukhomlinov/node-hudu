/**
 * ExportsResource — Hudu "exports" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Export } from '../types/index.js';

export interface ExportsListParams extends ListParams {}

export class ExportsResource extends BaseResource<Export> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'exports', singleKey: undefined, listKey: undefined, createType: 'wrapped', paginated: false });
  }

  list(params?: ExportsListParams): AsyncIterable<Export> {
    return this.items(params ?? {});
  }
  async listAll(params?: ExportsListParams): Promise<Export[]> {
    return this.all(params ?? {});
  }
  listPages(params?: ExportsListParams): AsyncIterable<Page<Export>> {
    return this.pageIter(params ?? {});
  }
  /** POST /exports — initiate an export. Returns 200 with empty body. */
  async create(data: Record<string, unknown>): Promise<void> {
    await this.http.request<unknown>({ method: 'POST', path: '/exports', body: data });
  }
  /** Get export metadata or, when download=true, the file blob. */
  async get(id: number, opts?: { download?: boolean }): Promise<Export | Blob> {
    if (opts?.download) {
      return this.http.request<Blob>({ method: 'GET', path: `/exports/${id}`, query: { download: true } });
    }
    return this.getOne<Export>(id);
  }
}
