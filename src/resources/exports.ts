/**
 * ExportsResource — Hudu "exports" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Export, ExportCreate } from '../types/index.js';

export type ExportsListParams = ListParams;

export class ExportsResource extends BaseResource<Export> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'exports', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
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
  /** POST /exports — initiate an export. Body is wrapped in `export` (spec). Returns 200 with empty body. */
  async create(data: ExportCreate): Promise<void> {
    await this.http.request<unknown>({ method: 'POST', path: '/exports', body: { export: data } });
  }
  /** Get export metadata or, when download=true, the file blob. */
  async get(id: number, opts?: { download?: boolean }): Promise<Export | Blob> {
    if (opts?.download) {
      return this.http.download({ method: 'GET', path: `/exports/${id}`, query: { download: true } });
    }
    return this.getOne<Export>(id);
  }
}
