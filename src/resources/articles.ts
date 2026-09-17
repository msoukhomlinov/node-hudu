/**
 * ArticlesResource — Hudu "articles" resource.
 */
import type { HttpClient } from '../http.js';
import { assertScanDecided } from './agent-layer-helpers.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Article, ArticleCreate, ArticleUpdate } from '../types/index.js';
import type { ArticleContext, ArticleContextExpand, ArticleIdentifier, ArticleSummary } from '../types/article.js';
import type { ContentFormat, DryRunResult, HelperOptions, MutationOptions, Resolution, ResolutionCandidate } from '../types/common.js';
import { HuduConfigError, HuduContentLossError, HuduError, ResolutionError } from '../errors.js';
import { htmlToMarkdown, markdownToHtml } from '../content/markdown.js';
import { diffArticleRoundTrip } from './article-html.js';
import { CompaniesResource, toCompanySummary } from './companies.js';
import { FoldersResource } from './folders.js';

/**
 * Options of `articles.search`. A search returns a LIST, so it offers neither
 * `resolutionDetails` (a `Resolution<T>` wrapper is meaningless for a list) nor a
 * guard: only `limit`, `expand` and the optional `company_id` narrowing are
 * accepted, and all three are honoured.
 */
export interface ArticleSearchOptions {
  /** Maximum rows returned; default 25, hard maximum 100. */
  limit?: number;
  /** Return the full records instead of the compact summaries. */
  expand?: boolean;
  /** Narrow the vendor `search` filter to one company. */
  company_id?: number;
}

/**
 * Options of the writers that have no prior revision and no stale guard: `create`,
 * `delete`, `archive` and `unarchive`. `{ dryRun: true }` describes the call
 * without issuing it. `expectedUpdatedAt` is deliberately NOT accepted here — it is
 * an update guard, and a declared-but-ignored option would mislead a caller.
 */
export interface WriteOptions {
  dryRun?: boolean;
}

/**
 * Options of `create` only. `format: 'markdown'` converts `data.content` to HTML before
 * posting -- kept OFF the shared {@link WriteOptions} (which `delete`, `archive` and
 * `unarchive` also use) so those three don't type-check a Markdown option they would
 * silently ignore.
 */
export interface ArticleCreateOptions extends WriteOptions {
  /** Interpret `data.content` as Markdown and convert it to HTML before sending. */
  format?: ContentFormat;
}

/**
 * Options of `update` only. `format`/`allowLossyMarkdown` are kept OFF the shared
 * {@link MutationOptions} (used by every other resource's `update`) so a caller of, say,
 * `companies.update` cannot pass `{ format: 'markdown' }` and have it silently ignored.
 */
export interface ArticleUpdateOptions extends MutationOptions {
  /** Interpret `data.content` as Markdown and convert it to HTML before sending. */
  format?: ContentFormat;
  /**
   * Proceed with a Markdown update that would destroy content in the STORED article.
   * Read the `findings` on the {@link HuduContentLossError} first -- this is how a
   * region the caller never edited gets overwritten.
   */
  allowLossyMarkdown?: boolean;
}

/** Options for reading a single article. */
export interface ArticleGetOptions {
  /**
   * Return `content` as Markdown instead of HTML. A read destroys nothing, so no loss is
   * reported here -- the guard belongs on the write path.
   */
  format?: ContentFormat;
}

/** Convert `content` in place when the caller asked for Markdown. */
function projectContent<T extends { content?: string }>(record: T, format?: ContentFormat): T {
  if (format !== 'markdown' || typeof record.content !== 'string') return record;
  return { ...record, content: htmlToMarkdown(record.content) };
}

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
  /**
   * Exact match on the article's stored slug — the identifier segment after `/kba/` in an
   * article URL, NOT the trailing human-readable SEO suffix and not the whole URL path.
   * Take the value from `article.slug` rather than assuming a length or format.
   * (Established 2026-07-25.)
   */
  slug?: string;
  search?: string;
  updated_at?: string;
}

export class ArticlesResource extends BaseResource<Article> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'articles', singleKey: 'article', listKey: 'articles', createType: 'raw', paginated: true });
  }

  /**
   * Get a articles by id. The full record is returned, `content` (the body HTML) included:
   * the Hudu REST API has no `include_content` flag, and none is needed on this path.
   *
   * GOTCHA — a body that "reads back empty" is almost always a projection, not a fetch:
   * the compact `ArticleSummary` returned by `resolve`, `findBySlug` and `search` DROPS
   * `content` (documented in `ArticleSummary`). Use this method, or pass `{ expand: true }`
   * to those helpers, when you need the HTML. (Some Hudu MCP servers expose an
   * `include_content` parameter of their own; that is a server-side concept, not an SDK or
   * REST one. Established 2026-07-25.)
   *
   * The body is HTML. `validateArticleHtml` / `diffArticleRoundTrip` in
   * `src/resources/article-html.ts` check it against Hudu's editor and renderer rules —
   * note that on write Hudu rewrites inline image `src` values to `/public_photo/<slug>`,
   * which is expected behaviour, not corruption.
   */
  async get(id: number, opts?: ArticleGetOptions): Promise<Article> {
    return projectContent(await this.getOne<Article>(id), opts?.format);
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
  async create(data: ArticleCreate, opts: ArticleCreateOptions & { dryRun: true }): Promise<DryRunResult<Article>>;
  /** Live create, mirroring `update`'s `dryRun?: false` overload: the plain `Article` return. */
  async create(data: ArticleCreate, opts: ArticleCreateOptions & { dryRun?: false }): Promise<Article>;
  async create(data: ArticleCreate, opts?: ArticleCreateOptions): Promise<Article | DryRunResult<Article>>;
  /**
   * POST /articles. `{ dryRun: true }` describes the create without issuing it.
   * A create has no prior revision, so there is no `expectedUpdatedAt` guard and
   * the option is not part of this signature.
   *
   * `{ format: 'markdown' }` converts `data.content` (Markdown) to HTML before sending.
   * A create has no STORED body to destroy, so unlike `update` this runs no loss guard
   * and issues no extra fetch.
   */
  async create(data: ArticleCreate, opts?: ArticleCreateOptions): Promise<Article | DryRunResult<Article>> {
    const payload =
      opts?.format === 'markdown' && typeof data.content === 'string'
        ? { ...data, content: markdownToHtml(data.content) }
        : data;
    return this.createOne<Article>(payload, undefined, opts);
  }

  async update(id: number, data: ArticleUpdate): Promise<Article>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: ArticleUpdate, opts: ArticleUpdateOptions & { dryRun: true }): Promise<DryRunResult<Article>>;
  /** Live update, optionally with the opt-in `expectedUpdatedAt` stale guard. */
  async update(id: number, data: ArticleUpdate, opts: ArticleUpdateOptions & { dryRun?: false }): Promise<Article>;
  async update(id: number, data: ArticleUpdate, opts?: ArticleUpdateOptions): Promise<Article | DryRunResult<Article>>;
  /**
   * PUT /articles/:id. `{ format: 'markdown' }` interprets `data.content` as Markdown.
   *
   * Writing Markdown is lossy -- callouts, accordions and task lists have no Markdown
   * representation -- so before converting anything this asks whether the article
   * ALREADY STORED survives an HTML -> Markdown -> HTML round trip. That framing catches
   * destruction of regions the caller never touched, independent of what they submitted.
   * A round trip that would lose content throws {@link HuduContentLossError} unless the
   * caller passes `allowLossyMarkdown: true`. A stored body that converts to EMPTY
   * Markdown (non-empty HTML holding nothing the converter can represent) is unambiguous
   * total loss: it throws the SAME {@link HuduContentLossError} (finding code
   * `ROUNDTRIP_BODY_EMPTY`), and `allowLossyMarkdown: true` applies to it.
   *
   * The guard's fetch is reused for the `expectedUpdatedAt` stale check (at most ONE
   * extra GET beyond the PUT, and zero when `format` is not `'markdown'`, when `data`
   * carries no `content`, or when `allowLossyMarkdown: true` is set without an
   * `expectedUpdatedAt` -- then nothing consumes the fetched record, so the fetch is
   * skipped). On the plain path with `expectedUpdatedAt`, the stale check still runs
   * inside `updateOne` and issues its own GET; that GET is not the guard's.
   *
   * A miss on the guard fetch surfaces as a `NotFoundError` naming `articles.update`,
   * not `articles.get`: the fetch is an internal step of the update, and the single audit
   * entry for it is likewise `articles.update`.
   *
   * Dry-run staleness diverges by format, deliberately: the Markdown path checks
   * `expectedUpdatedAt` (and runs the loss guard) even when `dryRun: true` -- the
   * unconditional check is the intended, stricter behaviour, and it issues the guard's
   * GET. The plain path goes straight to `updateOne`, whose dry-run returns BEFORE its
   * own stale check, so a dry-run HTML update with a stale `expectedUpdatedAt` neither
   * fetches nor throws.
   */
  async update(id: number, data: ArticleUpdate, opts?: ArticleUpdateOptions): Promise<Article | DryRunResult<Article>> {
    if (opts?.format !== 'markdown' || typeof data.content !== 'string') {
      return this.updateOne<Article>(id, data, undefined, opts);
    }

    // Two distinct reasons the loss guard is skipped (issue #43, Batch 2 #1):
    const guardSkippedByIntent = opts.allowLossyMarkdown === true; // (a) the caller declared intent to accept loss
    const staleCheckNeeded = opts.expectedUpdatedAt !== undefined;

    // Zero-fetch case (issue #43, Batch 2 #2): the guard is skipped by intent AND there is
    // no stale check to run, so the fetched record would feed NOTHING -- skip the fetch.
    // (The second skip reason -- stored content absent/null/not a string, i.e. nothing to
    // destroy -- can only be decided after the fetch, because only the fetch reveals the
    // stored body; it is applied below where the record is in hand.)
    if (guardSkippedByIntent && !staleCheckNeeded) {
      return this.updateOne<Article>(id, { ...data, content: markdownToHtml(data.content) }, undefined, opts);
    }

    // ONE fetch serves both the loss guard and the stale check. updateOne would issue its
    // own for expectedUpdatedAt, so the guard is run here and expectedUpdatedAt is consumed
    // here too -- assertNotStale takes the fetch as a callback, so the same record feeds both.
    // The fetch is issued AS `articles.update` (not `articles.get`): a miss -- 404 or
    // 200-with-empty-body -- names the operation the caller invoked, in the structured
    // error and in the single audit entry for the request (issue #43, Batch 2 #6).
    const ids = [id];
    const body = await this.request<unknown>({
      method: 'GET',
      path: `/${this.resourcePath}/${id}`,
      operation: 'articles.update',
      resourceIds: ids,
    });
    const current = this.assertSingleFound<Article>(this.unwrapSingle<Article>(body), 'articles.update', ids);
    await this.assertNotStale('articles.update', this.resourcePath, id, opts.expectedUpdatedAt, () =>
      Promise.resolve(current),
    );

    // Guard skip reason (b): the stored content is absent/null/not a string -- there is
    // nothing to destroy, so the round-trip question is moot.
    if (!guardSkippedByIntent && typeof current.content === 'string') {
      // The question is whether the STORED body survives the round trip: that catches
      // destruction of the regions the caller never touched, independent of what they sent.
      let storedMarkdown: string;
      try {
        storedMarkdown = htmlToMarkdown(current.content);
      } catch (err) {
        // A non-empty stored body that converts to EMPTY Markdown is unambiguous total
        // loss, not a configuration slip (issue #43, Batch 2 #4): surface it as
        // CONTENT_LOSS so the caller reads findings, and `allowLossyMarkdown` applies to
        // it (this whole block is skipped when the flag is set). The match is on the
        // converter's CONVERSION_EMPTY_OUTPUT code, not the message text (issue #43,
        // Batch 2 fix-round N1), so the sibling over-cap HuduConfigError (code
        // CONFIG_ERROR) and every other converter error propagate unchanged.
        if (err instanceof HuduConfigError && err.code === 'CONVERSION_EMPTY_OUTPUT') {
          throw new HuduContentLossError('articles.update', [
            {
              code: 'ROUNDTRIP_BODY_EMPTY',
              severity: 'error',
              impact: 'content',
              element: 'body',
              change: 'stripped',
              message:
                'the stored body is non-empty but converts to empty Markdown, so a Markdown update would replace it with nothing (total loss)',
            },
          ]);
        }
        throw err;
      }
      const findings = diffArticleRoundTrip(current.content, markdownToHtml(storedMarkdown));
      if (findings.some((f) => f.impact === 'content')) {
        throw new HuduContentLossError('articles.update', findings);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop it from `rest`
    const { expectedUpdatedAt: _checked, ...rest } = opts;
    return this.updateOne<Article>(id, { ...data, content: markdownToHtml(data.content) }, undefined, rest);
  }

  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts?: WriteOptions): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: WriteOptions): Promise<void | DryRunResult<void>> {
    return this.deleteOne(id, opts);
  }

  async archive(id: number): Promise<void>;
  /** Dry-run: describe the archive without issuing it. */
  async archive(id: number, opts: { dryRun: true }): Promise<DryRunResult<void>>;
  async archive(id: number, opts?: WriteOptions): Promise<void | DryRunResult<void>>;
  async archive(id: number, opts?: WriteOptions): Promise<void | DryRunResult<void>> {
    return this.setArchived(id, true, opts);
  }

  async unarchive(id: number): Promise<void>;
  /** Dry-run: describe the unarchive without issuing it. */
  async unarchive(id: number, opts: { dryRun: true }): Promise<DryRunResult<void>>;
  async unarchive(id: number, opts?: WriteOptions): Promise<void | DryRunResult<void>>;
  async unarchive(id: number, opts?: WriteOptions): Promise<void | DryRunResult<void>> {
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
   *
   * `limit` bounds the page size of a server-filtered scan; a direct `{ id }` fetch
   * has nothing to scan, so `limit` has no effect on that path.
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

  /**
   * Resolve an article by its slug, with an exact compare (policy §6).
   *
   * GOTCHA — pass the STORED slug, which is the identifier segment after `/kba/` in an
   * article URL, not the whole path and not the trailing human-readable SEO suffix that
   * follows it. The vendor `slug` filter is an exact match and this helper re-compares
   * exactly, so a URL fragment that includes the suffix resolves to `null` rather than to
   * the article you meant. Do not assume a fixed hash length; take the value from
   * `article.slug`. (Established 2026-07-25.)
   *
   * The compact `ArticleSummary` returned by default DROPS `content` — pass
   * `{ expand: true }` when you need the body HTML.
   */
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
  async search(query: string, opts: { expand: true; limit?: number; company_id?: number }): Promise<Article[]>;
  async search(query: string, opts?: ArticleSearchOptions): Promise<ArticleSummary[] | Article[]>;
  async search(query: string, opts?: ArticleSearchOptions): Promise<ArticleSummary[] | Article[]> {
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
   * The article plus its company and folder (policy §9). The article, its company and
   * its folder are three single-record fetches — there is no list to bound, so this
   * signature takes no `limit` (unlike `companies.getContext` / `assets.getContext`,
   * which do have sub-lists). A related record that no longer exists is `null`, never
   * an error.
   */
  async getContext(id: number, opts?: { expand?: boolean; format?: ContentFormat }): Promise<ArticleContext>;
  /** `expand: true` returns the full article record. */
  async getContext(id: number, opts: { expand: true; format?: ContentFormat }): Promise<ArticleContextExpand>;
  async getContext(id: number, opts?: { expand?: boolean; format?: ContentFormat }): Promise<ArticleContext | ArticleContextExpand>;
  async getContext(id: number, opts?: { expand?: boolean; format?: ContentFormat }): Promise<ArticleContext | ArticleContextExpand> {
    const article = await this.get(id);
    const companyId = typeof article.company_id === 'number' && article.company_id > 0 ? article.company_id : undefined;
    const folderId = typeof article.folder_id === 'number' && article.folder_id > 0 ? article.folder_id : undefined;
    const company = companyId === undefined ? null : await optionalGet(() => new CompaniesResource(this.http).get(companyId));
    const folder = folderId === undefined ? null : await optionalGet(() => new FoldersResource(this.http).get(folderId));
    if (opts?.expand === true) return { article: projectContent(article, opts?.format), company, folder };
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
    // A cap that stopped the scan cannot prove uniqueness: a single exact match must not be
    // handed back as a confident hit, so the shared guard throws RESOLUTION_TRUNCATED (policy §6).
    assertScanDecided({ operation, scanned: fetched.length, truncated: scan.scanTruncated });
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
    if (fetched.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: the vendor filter is inexact and returned ${fetched.length} articles, none matching exactly.`,
        { operation, resourceIds: fetched.map((article) => article.id) },
      );
    }
    return { value: null, resolutionCost: 'server-filter', scanned: fetched.length, scanTruncated: false };
  }
}
