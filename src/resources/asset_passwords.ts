/**
 * AssetPasswordsResource — Hudu "asset_passwords" resource.
 *
 * Sensitive resource (policy §7.3): every helper returns `AssetPasswordSummary`,
 * which drops `password` and `otp_secret` rather than blanking them, so a helper
 * can never pull a credential into an agent context. `get` still returns the full
 * record — returned data is never redacted implicitly.
 */
import type { HttpClient } from '../http.js';
import { assertScanDecided } from './agent-layer-helpers.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { AssetPassword, AssetPasswordCreate, AssetPasswordUpdate } from '../types/index.js';
import type { AssetPasswordIdentifier, AssetPasswordSummary } from '../types/asset_password.js';
import type { DryRunResult, HelperOptions, MutationOptions, Resolution, ResolutionCandidate } from '../types/common.js';
import { HuduConfigError, ResolutionError } from '../errors.js';

/**
 * Options of `asset_passwords.search`. A search returns a LIST, so it offers
 * neither `resolutionDetails` (a `Resolution<T>` wrapper is meaningless for a list)
 * nor a guard: only `limit`, `expand` and the optional `company_id` narrowing are
 * accepted, and all three are honoured.
 */
export interface AssetPasswordSearchOptions {
  /** Maximum rows returned; default 25, hard maximum 100. */
  limit?: number;
  /** Return the full records, including the secrets, instead of the summaries. */
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

/** Helper `limit` bounds (policy §9): default 25, hard maximum 100. */
const DEFAULT_HELPER_LIMIT = 25;
const MAX_HELPER_LIMIT = 100;

/** The identifier kinds `asset_passwords.resolve` documents. */
const PASSWORD_IDENTIFIER_KINDS =
  'asset_passwords.resolve accepts { id }, { name } or { slug } (optionally narrowed by { company_id }), ' +
  'or a bare numeric id / slug / exact name';

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

/** Ambiguity label for one password record. Never contains the secret. */
function passwordLabel(entry: AssetPassword): string {
  return `${entry.name} (slug ${entry.slug}, id ${entry.id})`;
}

/**
 * Compact projection of a full asset password record (policy §9). `password` and
 * `otp_secret` are dropped, not blanked: the summary has no credential key at all.
 */
export function toAssetPasswordSummary(entry: AssetPassword): AssetPasswordSummary {
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    company_id: entry.company_id,
    password_folder_id: entry.password_folder_id,
    password_folder_name: entry.password_folder_name,
    username: entry.username,
    url: entry.url,
    login_url: entry.login_url,
    password_type: entry.password_type,
    updated_at: entry.updated_at,
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

export interface AssetPasswordsListParams extends ListParams {
  name?: string;
  company_id?: number;
  archived?: boolean;
  slug?: string;
  search?: string;
  updated_at?: string;
}

export class AssetPasswordsResource extends BaseResource<AssetPassword> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'asset_passwords', singleKey: 'asset_password', listKey: 'asset_passwords', createType: 'wrapped', paginated: true });
  }

  /** Get a asset_passwords by id. Returns the full record, including the secret. */
  async get(id: number): Promise<AssetPassword> {
    return this.getOne<AssetPassword>(id);
  }
  /** Stream asset_passwords across pages. */
  list(params?: AssetPasswordsListParams): AsyncIterable<AssetPassword> {
    return this.items(params ?? {});
  }
  /** Get every asset_passwords. MCP-preferred read. */
  async listAll(params?: AssetPasswordsListParams): Promise<AssetPassword[]> {
    return this.all(params ?? {});
  }

  async create(data: AssetPasswordCreate): Promise<AssetPassword>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: AssetPasswordCreate, opts: { dryRun: true }): Promise<DryRunResult<AssetPassword>>;
  async create(data: AssetPasswordCreate, opts?: WriteOptions): Promise<AssetPassword | DryRunResult<AssetPassword>>;
  /**
   * POST /asset_passwords. `{ dryRun: true }` describes the create without issuing
   * it — the dry-run result carries no payload copy, so no secret is echoed. A create
   * has no prior revision, so there is no `expectedUpdatedAt` guard and the option is
   * not part of this signature.
   */
  async create(data: AssetPasswordCreate, opts?: WriteOptions): Promise<AssetPassword | DryRunResult<AssetPassword>> {
    return this.createOne<AssetPassword>({ asset_password: data }, undefined, opts);
  }

  async update(id: number, data: AssetPasswordUpdate): Promise<AssetPassword>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: AssetPasswordUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<AssetPassword>>;
  /** Live update, optionally with the opt-in `expectedUpdatedAt` stale guard. */
  async update(id: number, data: AssetPasswordUpdate, opts: MutationOptions & { dryRun?: false }): Promise<AssetPassword>;
  async update(id: number, data: AssetPasswordUpdate, opts?: MutationOptions): Promise<AssetPassword | DryRunResult<AssetPassword>>;
  async update(id: number, data: AssetPasswordUpdate, opts?: MutationOptions): Promise<AssetPassword | DryRunResult<AssetPassword>> {
    return this.updateOne<AssetPassword>(id, { asset_password: data }, undefined, opts);
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

  listPages(params?: AssetPasswordsListParams): AsyncIterable<Page<AssetPassword>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Agent-execution-layer helpers (policy §5-§9). The secret never leaves them.
  // ---------------------------------------------------------------------------

  /**
   * Resolve a password record from an id, slug or exact name (policy §6). A bare
   * value is read in the documented order: numeric id, slug, exact name. `{ id }`
   * (or a numeric bare value) is a direct fetch: a miss throws `NOT_FOUND`, never
   * `null`. The returned summary omits `password` and `otp_secret`; use `get` (or
   * `expand: true`) when the secret is genuinely needed.
   *
   * `limit` bounds the page size of a server-filtered scan; a direct `{ id }` fetch
   * has nothing to scan, so `limit` has no effect on that path.
   */
  async resolve(identifier: number | string | AssetPasswordIdentifier): Promise<AssetPasswordSummary | null>;
  /** `expand: true` returns the full record, including the secret. */
  async resolve(identifier: number | string | AssetPasswordIdentifier, opts: HelperOptions & { expand: true }): Promise<AssetPassword | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper (never carrying the secret). */
  async resolve(identifier: number | string | AssetPasswordIdentifier, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<AssetPasswordSummary>>;
  async resolve(
    identifier: number | string | AssetPasswordIdentifier,
    opts?: HelperOptions,
  ): Promise<AssetPasswordSummary | AssetPassword | null | Resolution<AssetPasswordSummary>>;
  async resolve(
    identifier: number | string | AssetPasswordIdentifier,
    opts?: HelperOptions,
  ): Promise<AssetPasswordSummary | AssetPassword | null | Resolution<AssetPasswordSummary>> {
    const resolution = await this.resolveRecord(identifier, opts);
    return projectResolution(resolution, opts, toAssetPasswordSummary) as
      | AssetPasswordSummary
      | AssetPassword
      | null
      | Resolution<AssetPasswordSummary>;
  }

  /** Resolve a password record by slug, with an exact compare (policy §6). */
  async findBySlug(slug: string): Promise<AssetPasswordSummary | null>;
  /** `expand: true` returns the full record, including the secret. */
  async findBySlug(slug: string, opts: HelperOptions & { expand: true }): Promise<AssetPassword | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async findBySlug(slug: string, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<AssetPasswordSummary>>;
  async findBySlug(slug: string, opts?: HelperOptions): Promise<AssetPasswordSummary | AssetPassword | null | Resolution<AssetPasswordSummary>>;
  async findBySlug(slug: string, opts?: HelperOptions): Promise<AssetPasswordSummary | AssetPassword | null | Resolution<AssetPasswordSummary>> {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new HuduConfigError('asset_passwords.findBySlug requires a non-empty slug');
    }
    const resolution = await this.filterScan({ slug }, (entry) => sameText(entry.slug, slug), 'asset_passwords.findBySlug', opts);
    return projectResolution(resolution, opts, toAssetPasswordSummary) as
      | AssetPasswordSummary
      | AssetPassword
      | null
      | Resolution<AssetPasswordSummary>;
  }

  /**
   * Text search through the vendor `search` filter, optionally narrowed with
   * `company_id`. `limit` defaults to 25 and is capped at 100. The summary omits
   * `password` and `otp_secret`, so a search never pulls a secret into context.
   */
  async search(query: string): Promise<AssetPasswordSummary[]>;
  /** `expand: true` returns the full records, including the secrets. */
  async search(query: string, opts: { expand: true; limit?: number; company_id?: number }): Promise<AssetPassword[]>;
  async search(query: string, opts?: AssetPasswordSearchOptions): Promise<AssetPasswordSummary[] | AssetPassword[]>;
  async search(query: string, opts?: AssetPasswordSearchOptions): Promise<AssetPasswordSummary[] | AssetPassword[]> {
    const size = helperLimit(opts?.limit);
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new HuduConfigError('asset_passwords.search requires a non-empty query');
    }
    const filter: Record<string, unknown> = { search: query };
    if (typeof opts?.company_id === 'number') filter.company_id = opts.company_id;
    const body = await this.request<unknown>({
      method: 'GET',
      path: `/${this.resourcePath}`,
      query: { ...filter, page: 1, page_size: size },
      operation: 'asset_passwords.search',
    });
    const items = this.unwrapList<AssetPassword>(body).slice(0, size);
    return opts?.expand === true ? items : items.map(toAssetPasswordSummary);
  }

  /** The identifier -> resolution table of `resolve` (policy §6). */
  private async resolveRecord(
    identifier: number | string | AssetPasswordIdentifier,
    opts?: HelperOptions,
  ): Promise<Resolution<AssetPassword>> {
    if (typeof identifier === 'number') return this.byId(identifier);
    if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (text.length === 0) throw new HuduConfigError(PASSWORD_IDENTIFIER_KINDS);
      if (/^\d+$/.test(text)) return this.byId(Number(text));
      const bySlug = await this.filterScan({ slug: text }, (entry) => sameText(entry.slug, text), 'asset_passwords.resolve', opts);
      if (bySlug.value !== null) return bySlug;
      return this.filterScan({ name: text }, (entry) => sameText(entry.name, text), 'asset_passwords.resolve', opts);
    }
    if (identifier === null || typeof identifier !== 'object') throw new HuduConfigError(PASSWORD_IDENTIFIER_KINDS);
    if (typeof identifier.id === 'number') return this.byId(identifier.id);
    const narrowed = typeof identifier.company_id === 'number' ? { company_id: identifier.company_id } : {};
    if (typeof identifier.slug === 'string') {
      return this.filterScan(
        { slug: identifier.slug, ...narrowed },
        (entry) => sameText(entry.slug, identifier.slug),
        'asset_passwords.resolve',
        opts,
      );
    }
    if (typeof identifier.name === 'string') {
      return this.filterScan(
        { name: identifier.name, ...narrowed },
        (entry) => sameText(entry.name, identifier.name),
        'asset_passwords.resolve',
        opts,
      );
    }
    throw new HuduConfigError(PASSWORD_IDENTIFIER_KINDS);
  }

  /** Direct fetch by id: a miss throws NOT_FOUND (never null). */
  private async byId(id: number): Promise<Resolution<AssetPassword>> {
    const entry = await this.get(id);
    return {
      value: entry,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: entry.id, label: passwordLabel(entry) } satisfies ResolutionCandidate],
    };
  }

  /**
   * One bounded, server-filtered scan (policy §6): the vendor filter narrows the
   * result set, the exact compare decides. Several matches throw
   * `RESOLUTION_AMBIGUOUS`; a scan stopped by the cap throws
   * `RESOLUTION_TRUNCATED` (never `null`); a complete scan with no match is `null`.
   * Only ids and non-credential labels are ever collected into candidates.
   */
  private async filterScan(
    filter: Record<string, unknown>,
    matches: (entry: AssetPassword) => boolean,
    operation: string,
    opts?: HelperOptions,
  ): Promise<Resolution<AssetPassword>> {
    const size = helperLimit(opts?.limit);
    const fetched: AssetPassword[] = [];
    const scan = await this.boundedScan<AssetPassword>(
      async (page) => {
        const body = await this.request<unknown>({
          method: 'GET',
          path: `/${this.resourcePath}`,
          query: { ...filter, page, page_size: size },
          operation,
        });
        const items = this.unwrapList<AssetPassword>(body);
        return { items, page, page_size: size, hasMore: items.length === size };
      },
      {
        match: (entry) => {
          fetched.push(entry);
          return false;
        },
        label: passwordLabel,
        resolutionCost: 'server-filter',
      },
    );
    const exact = fetched.filter(matches);
    if (exact.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: ${exact.length} asset passwords match the identifier exactly, so it is not unique.`,
        { operation, resourceIds: exact.map((entry) => entry.id) },
      );
    }
    // A cap that stopped the scan cannot prove uniqueness: a single exact match must not be
    // handed back as a confident hit, so the shared guard throws RESOLUTION_TRUNCATED (policy §6).
    assertScanDecided({ operation, scanned: fetched.length, truncated: scan.scanTruncated });
    const only = exact.length === 1 ? (exact[0] as AssetPassword) : undefined;
    if (only !== undefined) {
      return {
        value: only,
        resolutionCost: 'server-filter',
        scanned: fetched.length,
        scanTruncated: false,
        candidates: [{ id: only.id, label: passwordLabel(only) } satisfies ResolutionCandidate],
      };
    }
    if (fetched.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: the vendor filter is inexact and returned ${fetched.length} asset passwords, none matching exactly.`,
        { operation, resourceIds: fetched.map((entry) => entry.id) },
      );
    }
    return { value: null, resolutionCost: 'server-filter', scanned: fetched.length, scanTruncated: false };
  }
}
