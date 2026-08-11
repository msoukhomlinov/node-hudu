/**
 * Base resource scaffolding shared by all Hudu resource clients.
 */
import type { HttpClient, RequestOptions } from '../http.js';
import { unwrapByKey, unwrapList } from '../http.js';
import type { ListParams, Page } from '../pagination.js';
import { collectAll, paginate, paginateItems } from '../pagination.js';
import { HuduConfigError } from '../errors.js';

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
    // A wrapped create that cannot be unwrapped would silently return the
    // envelope typed as the resource. Require a singleKey to make that contract
    // explicit (A15).
    if (this.createType === 'wrapped' && !this.singleKey) {
      throw new HuduConfigError(
        `Resource "${cfg.resourcePath}" uses createType 'wrapped' but has no singleKey to unwrap the response`,
      );
    }
  }

  /** Build the per-page fetcher from user params. */
  protected pageFetcher(params: ListParams, extraQuery?: Record<string, unknown>): (page: number, pageSize: number) => Promise<Page<T>> {
    const query: Record<string, unknown> = { ...params, ...(extraQuery ?? {}) };
    if (!this.paginated) {
      // Non-paginated endpoint: fetch once, return everything as a single page.
      // page/page_size belong only to paginated lists; strip them so they are
      // never forwarded to endpoints whose spec accepts neither (A11).
      delete query.page;
      delete query.page_size;
      return async () => {
        const body = await this.http.request<unknown>({
          method: 'GET',
          path: `/${this.resourcePath}`,
          query,
        });
        const items = this.unwrapList<T>(body);
        // C12: non-paginated pages report the real item count (0 for empty), never a fabricated value.
        return { items, page: 1, page_size: items.length, hasMore: false };
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

  /** Extract pagination opts from user params (page, page_size). */
  private paginationOpts(params: ListParams): { page?: number; page_size?: number; guardNoProgress: boolean } {
    const page = typeof params.page === 'number' ? params.page : undefined;
    const rawPageSize = typeof params.page_size === 'number' ? params.page_size : undefined;
    const page_size = rawPageSize ?? 25;
    // page_size:0 would make hasMore (length === page_size) always true and the
    // short-page break (length < page_size) always false -> an infinite loop (A12).
    if (!Number.isInteger(page_size) || page_size < 1) {
      throw new HuduConfigError(`page_size must be a positive integer, got "${String(params.page_size)}"`);
    }
    // Non-integer (1.5) and non-positive (0/-N) `page` are invalid — symmetric
    // with page_size (F8).
    if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
      throw new HuduConfigError(`page must be a positive integer, got "${String(params.page)}"`);
    }
    // F4: the SDK's own bundled pagination opts into the no-progress guard
    // (runaway-loop protection); external callers of the public `paginate`
    // fetcher leave it off by default.
    return { page, page_size, guardNoProgress: true };
  }

  /** Async iterator of items (used by subclass 'list'). */
  protected items(params: ListParams, extraQuery?: Record<string, unknown>): AsyncIterable<T> {
    return paginateItems<T>(this.pageFetcher(params, extraQuery), this.paginationOpts(params));
  }

  /** Collect everything (used by subclass 'listAll'). */
  protected async all(params: ListParams, extraQuery?: Record<string, unknown>): Promise<T[]> {
    return collectAll<T>(this.pageFetcher(params, extraQuery), this.paginationOpts(params));
  }

  /** Async iterator of pages (used by subclass 'listPages'). */
  protected pageIter(params: ListParams, extraQuery?: Record<string, unknown>): AsyncIterable<Page<T>> {
    return paginate<T>(this.pageFetcher(params, extraQuery), this.paginationOpts(params));
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

  /**
   * Forwarding helper so downstream custom resources can issue requests
   * through the shared HttpClient (rate limiter, auth, error wrapping).
   * Documented public API of BaseResource (ARCHITECTURE.md §BaseResource).
   */
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

  /** PUT update, envelope-normalised. PUT responses are ALWAYS wrapped by singleKey (when set). */
  protected async updateOne<U = T>(id: number | string, data: unknown, query?: Record<string, unknown>): Promise<U> {
    const body = await this.http.request<unknown>({
      method: 'PUT',
      path: `/${this.resourcePath}/${id}`,
      body: data,
      query,
    });
    // Always unwrap by singleKey on PUT; when singleKey is undefined this is a pass-through.
    return this.unwrapSingle<U>(body);
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
