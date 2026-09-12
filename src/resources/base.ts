/**
 * Base resource scaffolding shared by all Hudu resource clients.
 */
import type { HttpClient, RequestOptions } from '../http.js';
import { unwrapByKey, unwrapList } from '../http.js';
import type { ListParams, Page } from '../pagination.js';
import { collectAll, paginate, paginateItems } from '../pagination.js';
import { HuduConfigError, ResolutionError, StaleObjectError } from '../errors.js';
import type {
  DryRunCheck,
  DryRunResult,
  FieldDiff,
  Identifier,
  MutationOptions,
  Resolution,
  ResolutionCost,
} from '../types/common.js';

/** Page size requested by a client scan. */
const SCAN_PAGE_SIZE = 25;

/** Numeric ids for one identifier, used for audit events and structured errors. */
function identifierIds(id: Identifier | undefined): number[] | undefined {
  if (id === undefined) return undefined;
  if (typeof id === 'number') return [id];
  if (typeof id === 'string') return /^\d+$/.test(id) ? [Number(id)] : undefined;
  return typeof id.id === 'number' ? [id.id] : undefined;
}

/** A mutation description handed to `buildDryRunResult`. */
export interface DryRunOperation {
  operation: string;
  method: string;
  path: string;
  ids?: number[];
  checks?: DryRunCheck[];
  diff?: FieldDiff[];
  affected?: number;
  scope?: 'single' | 'bulk';
  reversible?: boolean;
  warnings?: string[];
}

/**
 * True when an object looks like a mutation-options bag rather than a query bag.
 * `updateOne(id, data, query, opts)` keeps `query` in the third position for
 * backwards compatibility, so passing options there would silently send them as
 * query parameters (a real write). It is rejected instead.
 */
function looksLikeMutationOptions(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === 'dryRun' || key === 'expectedUpdatedAt');
}

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
          operation: `${this.resourcePath}.list`,
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
        operation: `${this.resourcePath}.list`,
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
      operation: `${this.resourcePath}.get`,
      resourceIds: identifierIds(id),
    }));
  }

  /** POST create, normalised by createType. */
  protected async createOne<U = T>(data: unknown, query?: Record<string, unknown>): Promise<U>;
  /** Dry-run: describe the create without issuing it. */
  protected async createOne<U = T>(data: unknown, query: Record<string, unknown> | undefined, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<U>>;
  protected async createOne<U = T>(data: unknown, query: Record<string, unknown> | undefined, opts: MutationOptions & { dryRun?: false }): Promise<U>;
  protected async createOne<U = T>(data: unknown, query: Record<string, unknown> | undefined, opts: MutationOptions | undefined): Promise<U | DryRunResult<U>>;
  protected async createOne<U = T>(data: unknown, query?: Record<string, unknown>, opts?: MutationOptions): Promise<U | DryRunResult<U>> {
    const operation = `${this.resourcePath}.create`;
    this.assertNoExpectedUpdatedAt('createOne', opts);
    if (opts?.dryRun) {
      return this.buildDryRunResult<U>({
        operation,
        method: 'POST',
        path: `/${this.resourcePath}`,
        checks: [this.payloadCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
      });
    }
    const body = await this.http.request<unknown>({
      method: 'POST',
      path: `/${this.resourcePath}`,
      body: data,
      query,
      operation,
    });
    return this.createType === 'wrapped' ? this.unwrapSingle<U>(body) : (body as U);
  }

  /**
   * PUT update, envelope-normalised. PUT responses are ALWAYS wrapped by singleKey (when set).
   *
   * Options are the FOURTH argument: `updateOne(id, data, query, { dryRun: true })` or
   * `updateOne(id, data, query, { expectedUpdatedAt })`. The third argument stays `query`
   * for backwards compatibility, and options passed there are rejected rather than sent
   * as query parameters.
   */
  protected async updateOne<U = T>(id: number | string, data: unknown, query?: Record<string, unknown>): Promise<U>;
  /** Dry-run: describe the update without issuing it. */
  protected async updateOne<U = T>(id: number | string, data: unknown, query: Record<string, unknown> | undefined, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<U>>;
  /** Live update, optionally with the opt-in stale guard. */
  protected async updateOne<U = T>(id: number | string, data: unknown, query: Record<string, unknown> | undefined, opts: MutationOptions & { dryRun?: false }): Promise<U>;
  /** Options held in a variable: the caller must narrow the result. */
  protected async updateOne<U = T>(id: number | string, data: unknown, query: Record<string, unknown> | undefined, opts: MutationOptions | undefined): Promise<U | DryRunResult<U>>;
  protected async updateOne<U = T>(id: number | string, data: unknown, query?: Record<string, unknown>, opts?: MutationOptions): Promise<U | DryRunResult<U>> {
    const operation = `${this.resourcePath}.update`;
    const ids = identifierIds(id);
    if (opts === undefined && query !== undefined && looksLikeMutationOptions(query)) {
      throw new HuduConfigError(
        'Mutation options must be the 4th argument: updateOne(id, data, query, { dryRun: true })',
      );
    }
    if (opts?.dryRun) {
      return this.buildDryRunResult<U>({
        operation,
        method: 'PUT',
        path: `/${this.resourcePath}/${id}`,
        ids,
        checks: [this.targetCheck(id), this.payloadCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
      });
    }
    if (opts?.expectedUpdatedAt !== undefined) {
      await this.assertNotStale(operation, this.resourcePath, id, opts.expectedUpdatedAt, () =>
        this.getOne<{ updated_at?: string }>(id),
      );
    }
    const body = await this.http.request<unknown>({
      method: 'PUT',
      path: `/${this.resourcePath}/${id}`,
      body: data,
      query,
      operation,
      resourceIds: ids,
    });
    // Always unwrap by singleKey on PUT; when singleKey is undefined this is a pass-through.
    return this.unwrapSingle<U>(body);
  }

  /** DELETE returning void. */
  protected async deleteOne(id: number | string): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  protected async deleteOne(id: number | string, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  protected async deleteOne(id: number | string, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  protected async deleteOne(id: number | string, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  protected async deleteOne(id: number | string, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    const operation = `${this.resourcePath}.delete`;
    const ids = identifierIds(id);
    this.assertNoExpectedUpdatedAt('deleteOne', opts);
    if (opts?.dryRun) {
      return this.buildDryRunResult<void>({
        operation,
        method: 'DELETE',
        path: `/${this.resourcePath}/${id}`,
        ids,
        checks: [this.targetCheck(id)],
        affected: 1,
        scope: 'single',
        reversible: false,
        warnings: ['dry-run does not inspect dependent records'],
      });
    }
    await this.http.request<unknown>({
      method: 'DELETE',
      path: `/${this.resourcePath}/${id}`,
      operation,
      resourceIds: ids,
    });
  }

  /** PUT archive/unarchive, side-effect (void). */
  protected async setArchived(id: number | string, archive: boolean): Promise<void>;
  /** Dry-run: describe the archive/unarchive without issuing it. */
  protected async setArchived(id: number | string, archive: boolean, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  protected async setArchived(id: number | string, archive: boolean, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  protected async setArchived(id: number | string, archive: boolean, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  protected async setArchived(id: number | string, archive: boolean, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    const action = archive ? 'archive' : 'unarchive';
    const operation = `${this.resourcePath}.${action}`;
    const ids = identifierIds(id);
    this.assertNoExpectedUpdatedAt('setArchived', opts);
    if (opts?.dryRun) {
      return this.buildDryRunResult<void>({
        operation,
        method: 'PUT',
        path: `/${this.resourcePath}/${id}/${action}`,
        ids,
        checks: [this.targetCheck(id)],
        affected: 1,
        scope: 'single',
        // Archiving is reversible: the unarchive endpoint exists for the same id.
        reversible: true,
      });
    }
    await this.http.request<unknown>({
      method: 'PUT',
      path: `/${this.resourcePath}/${id}/${action}`,
      operation,
      resourceIds: ids,
    });
  }

  // ---------------------------------------------------------------------------
  // Agent-execution-layer plumbing shared by all 35 resources (policy §6-§10).
  // ---------------------------------------------------------------------------

  /** Bounded parallelism for bulk helpers (client `concurrency`, default 4). */
  protected get concurrency(): number {
    return this.http.concurrency;
  }

  /**
   * Build a `DryRunResult` (policy §7.2). `simulated: true` is mandatory because the
   * server's computed result cannot be promised; `impact` defaults to a single-record,
   * non-reversible change unless the caller says otherwise.
   */
  protected buildDryRunResult<U = T>(op: DryRunOperation): DryRunResult<U> {
    const ids = op.ids ?? [];
    const result: DryRunResult<U> = {
      operation: op.operation,
      wouldApply: true,
      target: { resource: this.resourcePath, ids },
      request: { method: op.method, path: op.path },
      checks: op.checks ?? [],
      impact: {
        affected: op.affected ?? (ids.length > 0 ? ids.length : 1),
        scope: op.scope ?? 'single',
        reversible: op.reversible ?? false,
      },
      simulated: true,
      warnings: op.warnings ?? ['server-computed fields are not guaranteed by dry-run'],
    };
    if (op.diff !== undefined) result.diff = op.diff;
    return result;
  }

  /**
   * `expectedUpdatedAt` guards `updateOne` only. Passed to any other mutating
   * primitive it would be a silent no-op, so the caller is told instead of
   * believing a guard ran. No request is issued either way.
   */
  protected assertNoExpectedUpdatedAt(primitive: string, opts: MutationOptions | undefined): void {
    if (opts?.expectedUpdatedAt !== undefined) {
      throw new HuduConfigError(
        `${primitive}: expectedUpdatedAt is not supported on create/delete/archive - it guards update only (updateOne)`,
      );
    }
  }

  /** Dry-run check: a create/update carried a request body. */
  protected payloadCheck(data: unknown): DryRunCheck {
    const ok = data !== undefined && data !== null;
    return { name: 'payload-present', ok, detail: ok ? 'request body supplied' : 'no request body was supplied' };
  }

  /** Dry-run check: an update/delete/archive named a target. */
  protected targetCheck(id: number | string): DryRunCheck {
    const text = id === undefined || id === null ? '' : String(id);
    const ok = text.length > 0;
    return { name: 'target-identifier', ok, detail: ok ? `target ${text}` : 'no target identifier was supplied' };
  }

  /**
   * Exact-match client scan (policy §6), always bounded.
   *
   * - Pages through at most `maxScanPages` pages (default from `config.resolution`)
   *   and stops once `maxScanRecords` records have been examined.
   * - Returns the FIRST exact match as `resolutionCost: 'client-scan'`.
   * - A fetched page is fully examined — nothing already fetched is left unread — so
   *   `scanTruncated` is true only when a cap stopped the scan while the fetcher still
   *   reported `hasMore: true`. A NON-paginated fetcher (single page, `hasMore: false`)
   *   therefore never reports truncation, however many records it returned.
   * - `value: null` with `scanTruncated: false` is a complete scan that found nothing.
   *   `value: null` with `scanTruncated: true` means "undecided" — the caller must turn
   *   that into a `RESOLUTION_TRUNCATED` error, never into `null`.
   *
   * Never unbounded, and never `Promise.all` across pages.
   */
  protected async boundedScan<T>(
    fetchPage: (page: number, pageSize: number) => Promise<Page<T>>,
    opts: {
      match: (item: T) => boolean;
      maxScanRecords?: number;
      maxScanPages?: number;
      label: (item: T) => string;
      /** Optional id accessor; when present, a match reports itself as a candidate. */
      idOf?: (item: T) => number;
      /** Override the reported cost, e.g. 'server-filter' when the caller used a vendor filter. */
      resolutionCost?: ResolutionCost;
    },
  ): Promise<Resolution<T>> {
    const maxScanRecords = opts.maxScanRecords ?? this.http.resolution.maxScanRecords;
    const maxScanPages = opts.maxScanPages ?? this.http.resolution.maxScanPages;
    const cost: ResolutionCost = opts.resolutionCost ?? 'client-scan';
    let scanned = 0;
    for (let page = 1; ; page++) {
      const result = await fetchPage(page, SCAN_PAGE_SIZE);
      for (const item of result.items) {
        scanned++;
        if (opts.match(item)) {
          const resolution: Resolution<T> = {
            value: item,
            resolutionCost: cost,
            scanned,
            scanTruncated: false,
          };
          if (opts.idOf) resolution.candidates = [{ id: opts.idOf(item), label: opts.label(item) }];
          return resolution;
        }
      }
      // The whole fetched page was examined: a complete scan is decided here, and a
      // cap only matters when the fetcher still has pages left to read.
      if (!result.hasMore) return { value: null, resolutionCost: cost, scanned, scanTruncated: false };
      if (scanned >= maxScanRecords || page >= maxScanPages) {
        return { value: null, resolutionCost: cost, scanned, scanTruncated: true };
      }
    }
  }

  /**
   * Turn an undecided (truncated) scan into the structured `RESOLUTION_TRUNCATED`
   * error the policy requires, and pass a resolved value or a complete-scan `null`
   * straight through. Returning `null` for a truncated scan would be a lie.
   */
  protected static requireResolved<T>(
    resolution: Resolution<T>,
    opts: { resource: string; operation?: string; identifier?: Identifier },
  ): T | null {
    if (resolution.value !== null) return resolution.value;
    if (resolution.scanTruncated) {
      throw ResolutionError.truncated(
        `Client scan for ${opts.resource} was truncated after ${resolution.scanned} record(s); ` +
          'the record may exist beyond the scan cap and cannot be decided.',
        {
          operation: opts.operation,
          resourceIds: identifierIds(opts.identifier),
          suggestedAction:
            'Resolve by { id }, use a vendor-side filter, or raise resolution.maxScanRecords/maxScanPages.',
        },
      );
    }
    return null;
  }

  /**
   * Opt-in stale-object guard (policy §7.3). Hudu exposes no ETag/If-Match, so the
   * caller passes the `updated_at` it last read: the current record is fetched,
   * compared, and a mismatch throws `StaleObjectError` (code STALE_OBJECT, category
   * conflict, retryable false) BEFORE the mutation is issued.
   *
   * When `expectedUpdatedAt` is undefined this returns immediately — it must not cost
   * a request, and `updateOne` does not call it at all in that case.
   *
   * A fetched record with NO version field (undefined/null/empty `updated_at`) cannot
   * be verified at all — several Hudu record types (rack_storage_items, ip_addresses,
   * matchers, magic_dash, uploads) declare no `updated_at`. That is a configuration
   * mismatch, not a conflict, so it raises `HuduConfigError` instead of inventing a
   * false `STALE_OBJECT` that would tell the caller to re-read and retry forever.
   */
  protected async assertNotStale(
    op: string,
    resource: string,
    id: number | string,
    expectedUpdatedAt: string | undefined,
    fetchCurrent: () => Promise<{ updated_at?: string | null } | undefined>,
  ): Promise<void> {
    if (expectedUpdatedAt === undefined) return;
    const current = await fetchCurrent();
    const actual = current === undefined ? undefined : current.updated_at;
    if (actual === undefined || actual === null || actual === '') {
      throw new HuduConfigError(
        `assertNotStale: the current ${resource} record for ${String(id)} carries no updated_at, ` +
          'so the expectedUpdatedAt guard cannot be verified for this resource.',
        {
          operation: op,
          resourceIds: identifierIds(id),
          suggestedAction:
            'Pass { expectedUpdatedAt } only for a resource whose record declares updated_at; drop it for records without a version field.',
        },
      );
    }
    if (actual !== expectedUpdatedAt) {
      throw new StaleObjectError(
        `Stale object: ${resource} ${String(id)} was not at the expected revision for ${op} ` +
          `(expected updated_at ${expectedUpdatedAt}, found ${actual ?? 'none'})`,
        undefined,
        undefined,
        {
          operation: op,
          resourceIds: identifierIds(id),
          suggestedAction: 'Re-read the record, then retry the change against its current updated_at.',
        },
      );
    }
  }

  /**
   * Bounded-parallelism map for bulk work (policy §10): at most `concurrency`
   * promises in flight, order preserved, never an unbounded `Promise.all` over ids.
   */
  protected async mapConcurrent<X, Y>(
    items: readonly X[],
    fn: (item: X, index: number) => Promise<Y>,
    concurrency?: number,
  ): Promise<Y[]> {
    const limit = Math.max(1, Math.min(concurrency ?? this.http.concurrency, items.length));
    const results = new Array<Y>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        // noUncheckedIndexedAccess: `index` is always < items.length here.
        results[index] = await fn(items[index] as X, index);
      }
    };
    await Promise.all(Array.from({ length: limit }, worker));
    return results;
  }
}
