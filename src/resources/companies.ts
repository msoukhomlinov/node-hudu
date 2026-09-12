/**
 * CompaniesResource — Hudu "companies" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Company, CompanyCreate, CompanyUpdate } from '../types/index.js';
import type {
  CompanyContext,
  CompanyContextExpand,
  CompanyIdentifier,
  CompanySummary,
} from '../types/company.js';
import type {
  DryRunResult,
  HelperOptions,
  MutationOptions,
  Resolution,
  ResolutionCandidate,
} from '../types/common.js';
import { HuduConfigError, ResolutionError } from '../errors.js';
import { ArticlesResource, toArticleSummary } from './articles.js';
import { AssetPasswordsResource, toAssetPasswordSummary } from './asset_passwords.js';
import { AssetsResource, toAssetSummary } from './assets.js';
import { WebsitesResource } from './websites.js';

/**
 * Options of `companies.search`. A search returns a LIST, so it offers neither
 * `resolutionDetails` (a `Resolution<T>` wrapper is meaningless for a list) nor a
 * guard: only `limit` and `expand` are accepted, and both are honoured.
 */
export interface CompanySearchOptions {
  /** Maximum rows returned; default 25, hard maximum 100. */
  limit?: number;
  /** Return the full records instead of the compact summaries. */
  expand?: boolean;
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

/** Helper `limit` bounds (policy §9): default 25, hard maximum 100. */
const DEFAULT_HELPER_LIMIT = 25;
const MAX_HELPER_LIMIT = 100;

/** The identifier kinds `companies.resolve` documents. */
const COMPANY_IDENTIFIER_KINDS =
  'companies.resolve accepts { id }, { name }, { slug }, { website } or { domain }, or a bare ' +
  'numeric id / slug / exact name / domain';

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

/** Host part of a website URL or a bare domain: no scheme, no `www.`, no path, no port. */
function hostOf(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
  return (host ?? '').replace(/:\d+$/, '');
}

/** Ambiguity label for one company. */
function companyLabel(company: Company): string {
  return `${company.name} (slug ${company.slug}, id ${company.id})`;
}

/** Compact projection of a full company record (policy §9). */
export function toCompanySummary(company: Company): CompanySummary {
  return {
    id: company.id,
    name: company.name,
    nickname: company.nickname,
    slug: company.slug,
    website: company.website,
    phone_number: company.phone_number,
    city: company.city,
    state: company.state,
    id_number: company.id_number,
    archived: company.archived,
    url: company.url,
    updated_at: company.updated_at,
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

/** Collect at most `limit` items from a streamed list — the iterator stops fetching once reached. */
async function take<T>(items: AsyncIterable<T>, limit: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export interface CompaniesListParams extends ListParams {
  name?: string;
  phone_number?: string;
  website?: string;
  city?: string;
  id_number?: string;
  state?: string;
  slug?: string;
  search?: string;
  id_in_integration?: string;
  updated_at?: string;
}

export class CompaniesResource extends BaseResource<Company> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'companies', singleKey: 'company', listKey: 'companies', createType: 'raw', paginated: true });
  }

  /** Get a companies by id. */
  async get(id: number): Promise<Company> {
    return this.getOne<Company>(id);
  }
  /** Stream companies across pages. */
  list(params?: CompaniesListParams): AsyncIterable<Company> {
    return this.items(params ?? {});
  }
  /** Get every companies. MCP-preferred read. */
  async listAll(params?: CompaniesListParams): Promise<Company[]> {
    return this.all(params ?? {});
  }

  async create(data: CompanyCreate): Promise<Company>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: CompanyCreate, opts: { dryRun: true }): Promise<DryRunResult<Company>>;
  async create(data: CompanyCreate, opts?: WriteOptions): Promise<Company | DryRunResult<Company>>;
  /**
   * POST /companies. `{ dryRun: true }` describes the create without issuing it.
   * A create has no prior revision, so there is no `expectedUpdatedAt` guard and
   * the option is not part of this signature.
   */
  async create(data: CompanyCreate, opts?: WriteOptions): Promise<Company | DryRunResult<Company>> {
    return this.createOne<Company>(data, undefined, opts);
  }

  async update(id: number, data: CompanyUpdate): Promise<Company>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: CompanyUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Company>>;
  /** Live update, optionally with the opt-in `expectedUpdatedAt` stale guard. */
  async update(id: number, data: CompanyUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Company>;
  async update(id: number, data: CompanyUpdate, opts?: MutationOptions): Promise<Company | DryRunResult<Company>>;
  /**
   * PUT /companies/{id}, unwrapped by `singleKey`. `{ dryRun: true }` describes
   * the update; `{ expectedUpdatedAt }` is the opt-in stale guard (read-then-compare
   * before the PUT, mismatch -> STALE_OBJECT).
   */
  async update(id: number, data: CompanyUpdate, opts?: MutationOptions): Promise<Company | DryRunResult<Company>> {
    return this.updateOne<Company>(id, data, undefined, opts);
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

  /**
   * GET /companies/jump — follows the 302 redirect and returns the final location URL.
   */
  async jump(params: { integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<string> {
    return this.followRedirect('/companies/jump', params);
  }

  listPages(params?: CompaniesListParams): AsyncIterable<Page<Company>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Agent-execution-layer helpers (policy §5-§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve a company from an id, name, slug or domain (policy §6).
   *
   * `{ id }` (or a numeric bare value) is a direct fetch: a miss throws
   * `NOT_FOUND`, never `null`. A bare string is read in the documented order:
   * numeric id, slug, exact name, domain. `null` means a complete bounded scan
   * found nothing; a scan stopped by the resolution cap throws
   * `RESOLUTION_TRUNCATED`, and several matches throw `RESOLUTION_AMBIGUOUS`
   * with the candidate ids in `resourceIds`.
   *
   * `limit` bounds the page size of a server-filtered scan; a direct `{ id }` fetch
   * has nothing to scan, so `limit` has no effect on that path.
   */
  async resolve(identifier: number | string | CompanyIdentifier): Promise<CompanySummary | null>;
  /** `expand: true` returns the full record. */
  async resolve(identifier: number | string | CompanyIdentifier, opts: HelperOptions & { expand: true }): Promise<Company | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async resolve(identifier: number | string | CompanyIdentifier, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<CompanySummary>>;
  async resolve(
    identifier: number | string | CompanyIdentifier,
    opts?: HelperOptions,
  ): Promise<CompanySummary | Company | null | Resolution<CompanySummary>>;
  async resolve(
    identifier: number | string | CompanyIdentifier,
    opts?: HelperOptions,
  ): Promise<CompanySummary | Company | null | Resolution<CompanySummary>> {
    const resolution = await this.resolveRecord(identifier, opts);
    return projectResolution(resolution, opts, toCompanySummary) as CompanySummary | Company | null | Resolution<CompanySummary>;
  }

  /** Resolve a company by its website/domain, with an exact host compare (policy §6). */
  async findByDomain(domain: string): Promise<CompanySummary | null>;
  /** `expand: true` returns the full record. */
  async findByDomain(domain: string, opts: HelperOptions & { expand: true }): Promise<Company | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async findByDomain(domain: string, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<CompanySummary>>;
  async findByDomain(domain: string, opts?: HelperOptions): Promise<CompanySummary | Company | null | Resolution<CompanySummary>>;
  async findByDomain(
    domain: string,
    opts?: HelperOptions,
  ): Promise<CompanySummary | Company | null | Resolution<CompanySummary>> {
    const target = hostOf(domain);
    if (target.length === 0) throw new HuduConfigError('companies.findByDomain requires a non-empty domain');
    const resolution = await this.filterScan(
      { website: domain },
      (company) => hostOf(company.website) === target,
      'companies.findByDomain',
      opts,
    );
    return projectResolution(resolution, opts, toCompanySummary) as CompanySummary | Company | null | Resolution<CompanySummary>;
  }

  /** Resolve a company by its slug, with an exact compare (policy §6). */
  async findBySlug(slug: string): Promise<CompanySummary | null>;
  /** `expand: true` returns the full record. */
  async findBySlug(slug: string, opts: HelperOptions & { expand: true }): Promise<Company | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async findBySlug(slug: string, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<CompanySummary>>;
  async findBySlug(slug: string, opts?: HelperOptions): Promise<CompanySummary | Company | null | Resolution<CompanySummary>>;
  async findBySlug(slug: string, opts?: HelperOptions): Promise<CompanySummary | Company | null | Resolution<CompanySummary>> {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new HuduConfigError('companies.findBySlug requires a non-empty slug');
    }
    const resolution = await this.filterScan({ slug }, (company) => sameText(company.slug, slug), 'companies.findBySlug', opts);
    return projectResolution(resolution, opts, toCompanySummary) as CompanySummary | Company | null | Resolution<CompanySummary>;
  }

  /**
   * Text search through the vendor `search` filter. `limit` defaults to 25 and is
   * capped at 100 (a larger value throws `HuduConfigError`); one bounded request is
   * issued, never a full-account page walk.
   */
  async search(query: string): Promise<CompanySummary[]>;
  /** `expand: true` returns the full records. */
  async search(query: string, opts: { expand: true; limit?: number }): Promise<Company[]>;
  async search(query: string, opts?: CompanySearchOptions): Promise<CompanySummary[] | Company[]>;
  async search(query: string, opts?: CompanySearchOptions): Promise<CompanySummary[] | Company[]> {
    const size = helperLimit(opts?.limit);
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new HuduConfigError('companies.search requires a non-empty query');
    }
    const body = await this.request<unknown>({
      method: 'GET',
      path: `/${this.resourcePath}`,
      query: { search: query, page: 1, page_size: size },
      operation: 'companies.search',
    });
    const items = this.unwrapList<Company>(body).slice(0, size);
    return opts?.expand === true ? items : items.map(toCompanySummary);
  }

  /**
   * The company plus bounded lists of its assets, articles, websites and asset
   * passwords (policy §9). Each sub-list is a bounded fetch driven by `limit`
   * (default 25, max 100): no sub-fetch walks the account.
   */
  async getContext(id: number, opts?: { limit?: number }): Promise<CompanyContext>;
  /** `expand: true` returns the full records instead of the compact shapes. */
  async getContext(id: number, opts: { limit?: number; expand: true }): Promise<CompanyContextExpand>;
  async getContext(id: number, opts?: { limit?: number; expand?: boolean }): Promise<CompanyContext | CompanyContextExpand>;
  async getContext(id: number, opts?: { limit?: number; expand?: boolean }): Promise<CompanyContext | CompanyContextExpand> {
    const size = helperLimit(opts?.limit);
    const company = await this.get(id);
    const websiteParams = { company_id: id, page_size: size };
    const assetRows = await take(new AssetsResource(this.http).list(id, { page_size: size }), size);
    const articleRows = await take(new ArticlesResource(this.http).list({ company_id: id, page_size: size }), size);
    const websiteRows = await take(new WebsitesResource(this.http).list(websiteParams), size);
    const passwordRows = await take(new AssetPasswordsResource(this.http).list({ company_id: id, page_size: size }), size);
    if (opts?.expand === true) {
      return { company, assets: assetRows, articles: articleRows, websites: websiteRows, assetPasswords: passwordRows };
    }
    return {
      company: toCompanySummary(company),
      assets: assetRows.map(toAssetSummary),
      articles: articleRows.map(toArticleSummary),
      websites: websiteRows,
      assetPasswords: passwordRows.map(toAssetPasswordSummary),
    };
  }

  /**
   * The identifier -> resolution table of `resolve` (policy §6). Every branch is
   * either a direct fetch or one bounded server-filtered scan.
   */
  private async resolveRecord(
    identifier: number | string | CompanyIdentifier,
    opts?: HelperOptions,
  ): Promise<Resolution<Company>> {
    if (typeof identifier === 'number') return this.byId(identifier);
    if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (text.length === 0) throw new HuduConfigError(COMPANY_IDENTIFIER_KINDS);
      if (/^\d+$/.test(text)) return this.byId(Number(text));
      const bySlug = await this.filterScan({ slug: text }, (company) => sameText(company.slug, text), 'companies.resolve', opts);
      if (bySlug.value !== null) return bySlug;
      const byName = await this.filterScan({ name: text }, (company) => sameText(company.name, text), 'companies.resolve', opts);
      if (byName.value !== null) return byName;
      return this.filterScan({ website: text }, (company) => hostOf(company.website) === hostOf(text), 'companies.resolve', opts);
    }
    if (identifier === null || typeof identifier !== 'object') throw new HuduConfigError(COMPANY_IDENTIFIER_KINDS);
    if (typeof identifier.id === 'number') return this.byId(identifier.id);
    if (typeof identifier.slug === 'string') {
      return this.filterScan({ slug: identifier.slug }, (company) => sameText(company.slug, identifier.slug), 'companies.resolve', opts);
    }
    if (typeof identifier.name === 'string') {
      return this.filterScan({ name: identifier.name }, (company) => sameText(company.name, identifier.name), 'companies.resolve', opts);
    }
    const domain = identifier.website ?? identifier.domain;
    if (typeof domain === 'string') {
      const target = hostOf(domain);
      if (target.length === 0) throw new HuduConfigError(COMPANY_IDENTIFIER_KINDS);
      return this.filterScan({ website: domain }, (company) => hostOf(company.website) === target, 'companies.resolve', opts);
    }
    throw new HuduConfigError(COMPANY_IDENTIFIER_KINDS);
  }

  /** Direct fetch by id: a miss throws NOT_FOUND (never null). */
  private async byId(id: number): Promise<Resolution<Company>> {
    const company = await this.get(id);
    return {
      value: company,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: company.id, label: companyLabel(company) } satisfies ResolutionCandidate],
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
    matches: (company: Company) => boolean,
    operation: string,
    opts?: HelperOptions,
  ): Promise<Resolution<Company>> {
    const size = helperLimit(opts?.limit);
    const fetched: Company[] = [];
    const scan = await this.boundedScan<Company>(
      async (page) => {
        const body = await this.request<unknown>({
          method: 'GET',
          path: `/${this.resourcePath}`,
          query: { ...filter, page, page_size: size },
          operation,
        });
        const items = this.unwrapList<Company>(body);
        return { items, page, page_size: size, hasMore: items.length === size };
      },
      {
        match: (company) => {
          fetched.push(company);
          return false;
        },
        label: companyLabel,
        resolutionCost: 'server-filter',
      },
    );
    const exact = fetched.filter(matches);
    if (exact.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: ${exact.length} companies match the identifier exactly, so it is not unique.`,
        { operation, resourceIds: exact.map((company) => company.id) },
      );
    }
    const only = exact.length === 1 ? (exact[0] as Company) : undefined;
    if (only !== undefined) {
      return {
        value: only,
        resolutionCost: 'server-filter',
        scanned: fetched.length,
        scanTruncated: false,
        candidates: [{ id: only.id, label: companyLabel(only) } satisfies ResolutionCandidate],
      };
    }
    if (scan.scanTruncated) {
      throw ResolutionError.truncated(
        `${operation}: the bounded scan stopped after ${scan.scanned} company record(s), so the record ` +
          'may exist beyond the resolution cap and cannot be decided.',
        { operation },
      );
    }
    if (fetched.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: the vendor filter is inexact and returned ${fetched.length} companies, none matching exactly.`,
        { operation, resourceIds: fetched.map((company) => company.id) },
      );
    }
    return { value: null, resolutionCost: 'server-filter', scanned: fetched.length, scanTruncated: false };
  }
}
