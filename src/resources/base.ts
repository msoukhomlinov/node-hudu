/**
 * Base resource scaffolding shared by all Hudu resource clients.
 */
import type { HttpClient, RequestOptions } from '../http.js';
import { unwrapByKey, unwrapList } from '../http.js';
import type { ListParams, Page } from '../pagination.js';
import { collectAll, paginate, paginateItems } from '../pagination.js';

export interface BaseResourceConfig {
  /** Plural URL path under basePath, e.g. 'companies'. */
  resourcePath: string;
  /** Envelope key for single responses, e.g. 'company'. */
  singleKey?: string;
  /** Envelope key for list responses, e.g. 'companies'. */
  listKey?: string;
  /** 'raw' | 'wrapped' — how create/update responses arrive. */
  createType?: 'raw' | 'wrapped';
  /** Whether the list endpoint supports page/page_size. Default true. */
  paginated?: boolean;
}

/** A the list request carries query filters and pagination params. */
export type ListParamsWithFilters = ListParams;

export abstract class BaseResource<T = unknown> {
  protected readonly http: HttpClient;
  protected readonly resourcePath: string;
  protected readonly singleKey?: string;
  protected readonly listKey?: string;
  protected readonly createType: 'raw' | 'wrapped';
  protected readonly paginated: boolean;

  constructor(http: HttpClient, cfg: BaseResourceConfig) {
    this.http = http;
    this.resourcePath = cfg.resourcePath;
    this.singleKey = cfg.singleKey;
    this.listKey = cfg.listKey;
    this.createType = cfg.createType ?? 'raw';
    this.paginated = cfg.paginated ?? true;
  }

  /** Build the per-page fetcher from user params. */
  protected pageFetcher(params: ListParams, extraQuery?: Record<string, unknown>): (page: number, pageSize: number) => Promise<Page<T>> {
    const query = { ...params, ...(extraQuery ?? {}) };
    if (!this.paginated) {
      // Non-paginated endpoint: fetch once, return everything as a single page.
      return async () => {
        const body = await this.http.request<unknown>({
          method: 'GET',
          path: `/${this.resourcePath}`,
          query,
        });
        const items = this.unwrapList<T>(body);
        return { items, page: 1, page_size: Math.max(items.length, 1), hasMore: false };
      };
    }
    return async (page, pageSize) => {
      const body = await this.http.request<unknown>({
        method: 'GET',
        path: `/${this.resourcePath}`,
        query: { ...query, page, page_size: pageSize },
      });
      const items = this.unwrapList<T>(body);
      return { items, page, page_size: pageSize, hasMore: items.length === pageSize };
    };
  }

  /** Async iterator of items (used by subclass 'list'). */
  protected items(params: ListParams, extraQuery?: Record<string, unknown>): AsyncIterable<T> {
    return paginateItems<T>(this.pageFetcher(params, extraQuery));
  }

  /** Collect everything (used by subclass 'listAll'). */
  protected async all(params: ListParams, extraQuery?: Record<string, unknown>): Promise<T[]> {
    return collectAll<T>(this.pageFetcher(params, extraQuery));
  }

  /** Async iterator of pages (used by subclass 'listPages'). */
  protected pageIter(params: ListParams, extraQuery?: Record<string, unknown>): AsyncIterable<Page<T>> {
    return paginate<T>(this.pageFetcher(params, extraQuery));
  }

  /**
   * Follow a 302 redirect endpoint (e.g. /companies/jump) and return the final
   * location URL. Requires a non-JSON Accept so Hudu returns an HTML redirect.
   */
  protected async followRedirect(path: string, query: Record<string, unknown>): Promise<string> {
    return this.http.resolveRedirect(path, query);
  }

  /** Company-scoped request against a nested path, e.g. /companies/{cid}/assets. */
  protected companyUrl(companyId: number, base: string, id?: number | string): string {
    const seg = id !== undefined ? `/${id}` : '';
    return `/companies/${companyId}${base}${seg}`;
  }

  protected unwrapSingle<U = T>(data: unknown): U {
    return unwrapByKey<U>(data, this.singleKey);
  }

  protected unwrapList<U = T>(data: unknown): U[] {
    return unwrapList<U>(data, this.listKey);
  }

  protected async request<U>(opts: RequestOptions): Promise<U> {
    return this.http.request<U>(opts);
  }

  /** GET single with envelope unwrap; throws NotFoundError on 404. */
  protected async getOne<U = T>(id: number | string, query?: Record<string, unknown>): Promise<U> {
    return this.unwrapSingle<U>(await this.http.request<unknown>({
      method: 'GET',
      path: `/${this.resourcePath}/${id}`,
      query,
    }));
  }

  /** POST create, normalised by createType. */
  protected async createOne<U = T>(data: unknown, query?: Record<string, unknown>): Promise<U> {
    const body = await this.http.request<unknown>({
      method: 'POST',
      path: `/${this.resourcePath}`,
      body: data,
      query,
    });
    return this.createType === 'wrapped' ? this.unwrapSingle<U>(body) : (body as U);
  }

  /** PUT update, envelope-normalised. */
  protected async updateOne<U = T>(id: number | string, data: unknown, query?: Record<string, unknown>): Promise<U> {
    const body = await this.http.request<unknown>({
      method: 'PUT',
      path: `/${this.resourcePath}/${id}`,
      body: data,
      query,
    });
    return this.createType === 'wrapped' ? this.unwrapSingle<U>(body) : (body as U);
  }

  /** DELETE returning void. */
  protected async deleteOne(id: number | string): Promise<void> {
    await this.http.request<unknown>({ method: 'DELETE', path: `/${this.resourcePath}/${id}` });
  }

  /** PUT archive/unarchive, side-effect (void). */
  protected async setArchived(id: number | string, archive: boolean): Promise<void> {
    await this.http.request<unknown>({
      method: 'PUT',
      path: `/${this.resourcePath}/${id}/${archive ? 'archive' : 'unarchive'}`,
    });
  }
}
