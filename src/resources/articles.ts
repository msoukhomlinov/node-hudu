/**
 * ArticlesResource — Hudu "articles" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Article, ArticleCreate, ArticleUpdate } from '../types/index.js';
import type { ArticleContext, ArticleContextExpand, ArticleIdentifier, ArticleSummary } from '../types/article.js';
import type { DryRunResult, HelperOptions, MutationOptions, Resolution, ResolutionCandidate } from '../types/common.js';
import { HuduConfigError, HuduError, ResolutionError } from '../errors.js';
import { CompaniesResource, toCompanySummary } from './companies.js';
import { FoldersResource } from './folders.js';

/** Helper `limit` bounds (policy §9): default 25, hard maximum 100. */
const DEFAULT_HELPER_LIMIT = 25;
const MAX_HELPER_LIMIT = 100;

/** The identifier kinds `articles.resolve` documents. */
const ARTICLE_IDENTIFIER_KINDS =
  'articles.resolve accepts { id }, { name } or { slug } (optionally narrowed by { company_id }), or a bare ' +
  'numeric id / slug / exact name';

/** Validate a helper `limit`: default 25, hard maximum 100 — never silently clamped. */
function helperLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HELPER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HELPER_LIMIT) {
    throw new HuduConfigError(`limit must be an integer from 1 to ${MAX_HELPER_LIMIT}, got "${String(limit)}"`);
  }
  return limit;
}

/** Case-insensitive, whitespace-trimmed equality — the exact compare applied to a vendor filter. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Ambiguity label for one article. */
function articleLabel(article: Article): string {
  return `${article.name} (slug ${article.slug}, id ${article.id})`;
}

/** Compact projection of a full article record (policy §9). */
export function toArticleSummary(article: Article): ArticleSummary {
  return {
    id: article.id,
    name: article.name,
    slug: article.slug,
    company_id: article.company_id,
    folder_id: article.folder_id,
    draft: article.draft,
    enable_sharing: article.enable_sharing,
    updated_at: article.updated_at,
  };
}

/**
 * Apply the caller's requested shape to a resolution: compact by default,
 * `expand: true` for the full record, `resolutionDetails: true` for the
 * `Resolution<T>` wrapper (cost, scanned, scanTruncated, candidates).
 */
function projectResolution<U, S>(
  resolution: Resolution<U>,
  opts: HelperOptions | undefined,
  summarize: (item: U) => S,
): unknown {
  if (opts?.resolutionDetails === true) {
    if (resolution.value === null) return { ...resolution, value: null } as Resolution<S>;
    const value = (opts.expand === true ? resolution.value : summarize(resolution.value)) as S;
    return { ...resolution, value } as Resolution<S>;
  }
  if (resolution.value === null) return null;
  return opts?.expand === true ? resolution.value : summarize(resolution.value);
}

/** A missing (404) related record is context `null`, not an error for the article itself. */
async function optionalGet<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof HuduError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

export interface ArticlesListParams extends ListParams {
  name?: string;
  company_id?: number;
  draft?: boolean;
  enable_sharing?: boolean;
  slug?: string;
  search?: string;
  updated_at?: string;
}

export class ArticlesResource extends BaseResource<Article> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'articles', singleKey: 'article', listKey: 'articles', createType: 'raw', paginated: true });
  }

  /** Get a articles by id. */
  async get(id: number): Promise<Article> {
    return this.getOne<Article>(id);
  }
  /** Stream articles across pages. */
  list(params?: ArticlesListParams): AsyncIterable<Article> {
    return this.items(params ?? {});
  }
  /** Get every articles. MCP-preferred read. */
  async listAll(params?: ArticlesListParams): Promise<Article[]> {
    return this.all(params ?? {});
  }

  async create(data: ArticleCreate): Promise<Article>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: ArticleCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Article>>;
  async create(data: ArticleCreate, opts?: MutationOptions): Promise<Article | DryRunResult<Article>>;
  /**
   * POST /articles. `{ dryRun: true }` describes the create without issuing it.
   * The `expectedUpdatedAt` guard is an UPDATE guard: a create has no prior
   * revision to compare against, so the option is accepted and ignored here.
   */
  async create(data: ArticleCreate, opts?: MutationOptions): Promise<Article | DryRunResult<Article>> {
    return this.createOne<Article>(data, undefined, opts);
  }

  async update(id: number, data: ArticleUpdate): Promise<Article>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: ArticleUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Article>>;
  /** Live update, optionally with the opt-in `expectedUpdatedAt` stale guard. */
  async update(id: number, data: ArticleUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Article>;
  async update(id: number, data: ArticleUpdate, opts?: MutationOptions): Promise<Article | DryRunResult<Article>>;
  async update(id: number, data: ArticleUpdate, opts?: MutationOptions): Promise<Article | DryRunResult<Article>> {
    return this.updateOne<Article>(id, data, undefined, opts);
  }

  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    return this.deleteOne(id, opts);
  }

  async archive(id: number): Promise<void>;
  /** Dry-run: describe the archive without issuing it. */
  async archive(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async archive(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>>;
  async archive(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    return this.setArchived(id, true, opts);
  }

  async unarchive(id: number): Promise<void>;
  /** Dry-run: describe the unarchive without issuing it. */
  async unarchive(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async unarchive(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>>;
  async unarchive(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    return this.setArchived(id, false, opts);
  }

  listPages(params?: ArticlesListParams): AsyncIterable<Page<Article>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Agent-execution-layer helpers (policy §5-§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve an article from an id, slug or exact name (policy §6). A bare value is
   * read in the documented order: numeric id, slug, exact name. `{ id }` (or a
   * numeric bare value) is a direct fetch: a miss throws `NOT_FOUND`, never `null`.
   * A complete bounded scan with no match returns `null`; a scan stopped by the
   * cap throws `RESOLUTION_TRUNCATED`; several matches throw
   * `RESOLUTION_AMBIGUOUS` with the candidate ids in `resourceIds`.
   */
  async resolve(identifier: number | string | ArticleIdentifier): Promise<ArticleSummary | null>;
  /** `expand: true` returns the full record. */
  async resolve(identifier: number | string | ArticleIdentifier, opts: HelperOptions & { expand: true }): Promise<Article | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async resolve(identifier: number | string | ArticleIdentifier, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<ArticleSummary>>;
  async resolve(
    identifier: number | string | ArticleIdentifier,
    opts?: HelperOptions,
  ): Promise<ArticleSummary | Article | null | Resolution<ArticleSummary>>;
  async resolve(
    identifier: number | string | ArticleIdentifier,
    opts?: HelperOptions,
  ): Promise<ArticleSummary | Article | null | Resolution<ArticleSummary>> {
    const resolution = await this.resolveRecord(identifier, opts);
    return projectResolution(resolution, opts, toArticleSummary) as ArticleSummary | Article | null | Resolution<ArticleSummary>;
  }

  /** Resolve an article by its slug, with an exact compare (policy §6). */
  async findBySlug(slug: string): Promise<ArticleSummary | null>;
  /** `expand: true` returns the full record. */
  async findBySlug(slug: string, opts: HelperOptions & { expand: true }): Promise<Article | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async findBySlug(slug: string, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<ArticleSummary>>;
  async findBySlug(slug: string, opts?: HelperOptions): Promise<ArticleSummary | Article | null | Resolution<ArticleSummary>>;
  async findBySlug(slug: string, opts?: HelperOptions): Promise<ArticleSummary | Article | null | Resolution<ArticleSummary>> {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new HuduConfigError('articles.findBySlug requires a non-empty slug');
    }
    const resolution = await this.filterScan({ slug }, (article) => sameText(article.slug, slug), 'articles.findBySlug', opts);
    return projectResolution(resolution, opts, toArticleSummary) as ArticleSummary | Article | null | Resolution<ArticleSummary>;
  }

  /**
   * Text search through the vendor `search` filter, optionally narrowed with
   * `company_id`. `limit` defaults to 25 and is capped at 100 (a larger value
   * throws `HuduConfigError`).
   */
  async search(query: string): Promise<ArticleSummary[]>;
  /** `expand: true` returns the full records. */
  async search(query: string, opts: HelperOptions & { expand: true }): Promise<Article[]>;
  async search(query: string, opts?: HelperOptions & { company_id?: number }): Promise<ArticleSummary[] | Article[]>;
  async search(query: string, opts?: HelperOptions & { company_id?: number }): Promise<ArticleSummary[] | Article[]> {
    const size = helperLimit(opts?.limit);
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new HuduConfigError('articles.search requires a non-empty query');
    }
    const filter: Record<string, unknown> = { search: query };
    if (typeof opts?.company_id === 'number') filter.company_id = opts.company_id;
    const body = await this.request<unknown>({
      method: 'GET',
      path: `/${this.resourcePath}`,
      query: { ...filter, page: 1, page_size: size },
      operation: 'articles.search',
    });
    const items = this.unwrapList<Article>(body).slice(0, size);
    return opts?.expand === true ? items : items.map(toArticleSummary);
  }

  /**
   * The article plus its company and folder (policy §9). Each part is a bounded
   * fetch; a related record that no longer exists is `null`, never an error.
   */
  async getContext(id: number, opts?: { limit?: number }): Promise<ArticleContext>;
  /** `expand: true` returns the full article record. */
  async getContext(id: number, opts: { limit?: number; expand: true }): Promise<ArticleContextExpand>;
  async getContext(id: number, opts?: { limit?: number; expand?: boolean }): Promise<ArticleContext | ArticleContextExpand>;
  async getContext(id: number, opts?: { limit?: number; expand?: boolean }): Promise<ArticleContext | ArticleContextExpand> {
    const article = await this.get(id);
    const companyId = typeof article.company_id === 'number' && article.company_id > 0 ? article.company_id : undefined;
    const folderId = typeof article.folder_id === 'number' && article.folder_id > 0 ? article.folder_id : undefined;
    const company = companyId === undefined ? null : await optionalGet(() => new CompaniesResource(this.http).get(companyId));
    const folder = folderId === undefined ? null : await optionalGet(() => new FoldersResource(this.http).get(folderId));
    if (opts?.expand === true) return { article, company, folder };
    return {
      article: toArticleSummary(article),
      company: company === null ? null : toCompanySummary(company),
      folder,
    };
  }

  /** The identifier -> resolution table of `resolve` (policy §6). */
  private async resolveRecord(
    identifier: number | string | ArticleIdentifier,
    opts?: HelperOptions,
  ): Promise<Resolution<Article>> {
    if (typeof identifier === 'number') return this.byId(identifier);
    if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (text.length === 0) throw new HuduConfigError(ARTICLE_IDENTIFIER_KINDS);
      if (/^\d+$/.test(text)) return this.byId(Number(text));
      const bySlug = await this.filterScan({ slug: text }, (article) => sameText(article.slug, text), 'articles.resolve', opts);
      if (bySlug.value !== null) return bySlug;
      return this.filterScan({ name: text }, (article) => sameText(article.name, text), 'articles.resolve', opts);
    }
    if (identifier === null || typeof identifier !== 'object') throw new HuduConfigError(ARTICLE_IDENTIFIER_KINDS);
    if (typeof identifier.id === 'number') return this.byId(identifier.id);
    const narrowed = typeof identifier.company_id === 'number' ? { company_id: identifier.company_id } : {};
    if (typeof identifier.slug === 'string') {
      return this.filterScan(
        { slug: identifier.slug, ...narrowed },
        (article) => sameText(article.slug, identifier.slug),
        'articles.resolve',
        opts,
      );
    }
    if (typeof identifier.name === 'string') {
      return this.filterScan(
        { name: identifier.name, ...narrowed },
        (article) => sameText(article.name, identifier.name),
        'articles.resolve',
        opts,
      );
    }
    throw new HuduConfigError(ARTICLE_IDENTIFIER_KINDS);
  }

  /** Direct fetch by id: a miss throws NOT_FOUND (never null). */
  private async byId(id: number): Promise<Resolution<Article>> {
    const article = await this.get(id);
    return {
      value: article,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: article.id, label: articleLabel(article) } satisfies ResolutionCandidate],
    };
  }

  /**
   * One bounded, server-filtered scan (policy §6): the vendor filter narrows the
   * result set, the exact compare decides. Several matches throw
   * `RESOLUTION_AMBIGUOUS`; a scan stopped by the cap throws
   * `RESOLUTION_TRUNCATED` (never `null`); a complete scan with no match is `null`.
   */
  private async filterScan(
    filter: Record<string, unknown>,
    matches: (article: Article) => boolean,
    operation: string,
    opts?: HelperOptions,
  ): Promise<Resolution<Article>> {
    const size = helperLimit(opts?.limit);
    const fetched: Article[] = [];
    const scan = await this.boundedScan<Article>(
      async (page) => {
        const body = await this.request<unknown>({
          method: 'GET',
          path: `/${this.resourcePath}`,
          query: { ...filter, page, page_size: size },
          operation,
        });
        const items = this.unwrapList<Article>(body);
        return { items, page, page_size: size, hasMore: items.length === size };
      },
      {
        match: (article) => {
          fetched.push(article);
          return false;
        },
        label: articleLabel,
        resolutionCost: 'server-filter',
      },
    );
    const exact = fetched.filter(matches);
    if (exact.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: ${exact.length} articles match the identifier exactly, so it is not unique.`,
        { operation, resourceIds: exact.map((article) => article.id) },
      );
    }
    const only = exact.length === 1 ? (exact[0] as Article) : undefined;
    if (only !== undefined) {
      return {
        value: only,
        resolutionCost: 'server-filter',
        scanned: fetched.length,
        scanTruncated: false,
        candidates: [{ id: only.id, label: articleLabel(only) } satisfies ResolutionCandidate],
      };
    }
    if (scan.scanTruncated) {
      throw ResolutionError.truncated(
        `${operation}: the bounded scan stopped after ${scan.scanned} article record(s), so the record ` +
          'may exist beyond the resolution cap and cannot be decided.',
        { operation },
      );
    }
    if (fetched.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: the vendor filter is inexact and returned ${fetched.length} articles, none matching exactly.`,
        { operation, resourceIds: fetched.map((article) => article.id) },
      );
    }
    return { value: null, resolutionCost: 'server-filter', scanned: fetched.length, scanTruncated: false };
  }
}
