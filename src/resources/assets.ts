/**
 * AssetsResource — Hudu "companies/{companyId}/assets" resource (company-scoped).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page, PaginateOptions } from '../pagination.js';
import { collectAll, paginate, paginateItems } from '../pagination.js';
import type { Asset, AssetCreate, AssetUpdate } from '../types/index.js';
import type {
  AssetContext, AssetContextExpand, AssetIdentifier, AssetIncludeGroup, AssetIncludes,
  AssetSummary, AssetSummaryWithIncludes, AssetWithIncludes,
} from '../types/asset.js';
import type { DryRunResult, HelperOptions, Resolution, ResolutionCandidate } from '../types/common.js';
import { HuduConfigError, HuduError, NotFoundError, ResolutionError } from '../errors.js';
import { assertScanDecided, refuseDryRunInPayload, refuseExpectedUpdatedAtOutsideUpdate } from './agent-layer-helpers.js';
import { DEFAULT_PAGE_SIZE } from '../config.js';
import { AssetLayoutsResource, toAssetLayoutSummary } from './asset_layouts.js';
import { ExpirationsResource, toExpirationSummary } from './expirations.js';
import { PhotosResource, toPhotoSummary } from './photos.js';
import { RelationsResource, toRelationSummary } from './relations.js';

/**
 * Options of `assets.search`. A search returns a LIST, so it offers neither
 * `resolutionDetails` (a `Resolution<T>` wrapper is meaningless for a list) nor a
 * guard: only `limit`, `expand` and the optional `company_id` narrowing are
 * accepted, and all three are honoured.
 */
export interface AssetSearchOptions {
  /** Maximum rows returned; default 25, hard maximum 100. */
  limit?: number;
  /** Return the full records instead of the compact summaries. */
  expand?: boolean;
  /** Narrow the account-wide `search` filter to one company. */
  company_id?: number;
  /**
   * Narrow the search to the asset whose `primary_serial` is EXACTLY this value.
   *
   * This is the vendor's `?primary_serial=` filter, and it is the only way to search by serial:
   * the free-text `search` filter does not index serials, so `search('SER88')` matches nothing while
   * `search('SER88N9X', { primary_serial: 'SER88N9X' })` returns the one asset (both measured against
   * a live 2.45.1 tenant). The comparison is exact, not a prefix or substring match. An empty string
   * is ignored, exactly as a non-numeric `company_id` is.
   */
  primary_serial?: string;
}

/**
 * Options of the asset writers that have no prior revision and no stale guard
 * (`create`, `update`, `delete`, `archive`, `unarchive`, `moveLayout`). The asset
 * writers are hand-rolled (the resource path is company-scoped), so no write path
 * here runs `updateOne`'s opt-in guard and `expectedUpdatedAt` is not offered in the
 * declared type. The type is not the guard: a JS (or agent-built) options object can
 * still carry the key, so every one of these paths REFUSES it with `HuduConfigError`
 * (`refuseExpectedUpdatedAtOutsideUpdate`) rather than dropping it and landing the
 * write. Callers that need the guard read `updated_at` themselves and compare before
 * deciding to write.
 */
export interface AssetWriteOptions {
  dryRun?: boolean;
}

/** Helper `limit` bounds (policy §9): default 25, hard maximum 100. */
const DEFAULT_HELPER_LIMIT = 25;
const MAX_HELPER_LIMIT = 100;

/** The identifier kinds `assets.resolve` documents. */
const ASSET_IDENTIFIER_KINDS =
  'assets.resolve accepts { companyId, id } for a direct company-scoped fetch, an account-wide ' +
  '{ id }, { name }, { slug } or { primary_serial }, or a bare numeric id / serial / name / slug';

/** Validate a helper `limit`: default 25, hard maximum 100 — never silently clamped. */
function helperLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HELPER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HELPER_LIMIT) {
    throw new HuduConfigError(`limit must be an integer from 1 to ${MAX_HELPER_LIMIT}, got "${String(limit)}"`);
  }
  return limit;
}

/**
 * A company-scoped entry point's `companyId`, checked BEFORE any IO.
 *
 * `assets` is the one company-scoped resource and its methods interpolate the id
 * straight into the request path, so an absent or malformed id used to reach the
 * vendor as a literal `undefined` segment (`/companies/undefined/assets`) and come
 * back as an opaque vendor 500. This names the operation and the value instead.
 */
function requireCompanyId(companyId: number | undefined, method: string): number {
  if (typeof companyId !== 'number' || !Number.isInteger(companyId) || companyId < 1) {
    throw new HuduConfigError(`${method} requires a positive integer companyId, got "${String(companyId)}"`);
  }
  return companyId;
}

/** The relation groups `include` accepts on the asset list-shaped calls. */
const ASSET_INCLUDE_GROUPS: AssetIncludeGroup[] = ['layout', 'expirations', 'relations', 'photos'];

/**
 * Validate an `include` array BEFORE any IO (validate-before-IO rule). An unknown group
 * name is a structured `HuduConfigError` naming the operation, the offending group and
 * the valid groups — explicit for agent callers. Returns the de-duplicated groups in
 * first-seen order; an absent or empty array means "no extras" (today's behavior).
 */
function validateIncludeGroups(include: readonly string[] | undefined, operation: string): AssetIncludeGroup[] {
  if (include === undefined) return [];
  if (!Array.isArray(include)) {
    throw new HuduConfigError(
      `${operation}: include must be an array of group names, got ${typeof include}`,
      { operation, suggestedAction: "Pass an array, e.g. include: ['expirations']." },
    );
  }
  const seen: AssetIncludeGroup[] = [];
  for (const group of include) {
    if (!ASSET_INCLUDE_GROUPS.includes(group)) {
      throw new HuduConfigError(
        `${operation}: unknown include group "${String(group)}"; valid groups are ${ASSET_INCLUDE_GROUPS.join(', ')}`,
        { operation, suggestedAction: `Pass one of: ${ASSET_INCLUDE_GROUPS.join(', ')}.` },
      );
    }
    if (!seen.includes(group)) seen.push(group);
  }
  return seen;
}

/** The fields the include-group fetchers read from an asset (both `Asset` and `AssetSummary` satisfy it). */
type AssetIncludeSource = { id: number; company_id: number; asset_layout_id: number };

/** Case-insensitive, whitespace-trimmed equality — the exact compare applied to a vendor filter. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Ambiguity label for one asset. */
function assetLabel(asset: Asset): string {
  return `${asset.name} (serial ${asset.primary_serial}, id ${asset.id})`;
}

/** Compact projection of a full asset record (policy §9). */
export function toAssetSummary(asset: Asset): AssetSummary {
  return {
    id: asset.id,
    name: asset.name,
    company_id: asset.company_id,
    company_name: asset.company_name,
    asset_layout_id: asset.asset_layout_id,
    primary_serial: asset.primary_serial,
    asset_type: asset.asset_type,
    archived: asset.archived,
    url: asset.url,
    updated_at: asset.updated_at,
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

/** A missing (404) related record is context `null`, not an error for the asset itself. */
async function optionalGet<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof HuduError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
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

export interface CompanyAssetsListParams extends ListParams {
  archived?: boolean;
}

export interface AccountAssetsListParams extends ListParams {
  company_id?: number;
  id?: number;
  name?: string;
  primary_serial?: string;
  asset_layout_id?: number;
  archived?: boolean;
  slug?: string;
  search?: string;
  updated_at?: string;
}

export class AssetsResource extends BaseResource<Asset> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'companies/{companyId}/assets', singleKey: 'asset', listKey: 'assets', createType: 'raw', paginated: true });
  }

  async get(companyId: number, id: number): Promise<Asset> {
    const company = requireCompanyId(companyId, 'assets.get');
    const body = await this.http.request<unknown>({ method: 'GET', path: `/companies/${company}/assets/${id}`, operation: 'assets.get', resourceIds: [id] });
    return this.unwrapSingle<Asset>(body);
  }

  /**
   * `include` attaches the named relation groups to each asset (each group = its own fetch).
   * Declared BEFORE the plain overload on purpose: `ListParams` carries an index signature, so
   * the plain overload accepts `{ include: [...] }` too and would otherwise shadow this one.
   */
  list(companyId: number, params: CompanyAssetsListParams & { include: AssetIncludeGroup[] }): AsyncIterable<AssetWithIncludes>;
  list(companyId: number, params?: CompanyAssetsListParams): AsyncIterable<Asset>;
  list(companyId: number, params?: CompanyAssetsListParams & { include?: AssetIncludeGroup[] }): AsyncIterable<Asset | AssetWithIncludes> {
    requireCompanyId(companyId, 'assets.list');
    const groups = validateIncludeGroups(params?.include, 'assets.list');
    const vendor = this.vendorParams(params);
    const base = paginateItems<Asset>((page, pageSize) => this.fetchScopedPage(companyId, vendor, page, pageSize), this.companyPaginationOpts(vendor));
    return groups.length === 0 ? base : this.withIncludes(base, groups, this.includePageSize(params));
  }

  /** `include` attaches the named relation groups to each asset (each group = its own fetch); keep before the plain overload (see `list`). */
  async listAll(companyId: number, params: CompanyAssetsListParams & { include: AssetIncludeGroup[] }): Promise<AssetWithIncludes[]>;
  async listAll(companyId: number, params?: CompanyAssetsListParams): Promise<Asset[]>;
  async listAll(companyId: number, params?: CompanyAssetsListParams & { include?: AssetIncludeGroup[] }): Promise<Asset[] | AssetWithIncludes[]> {
    requireCompanyId(companyId, 'assets.listAll');
    const groups = validateIncludeGroups(params?.include, 'assets.listAll');
    const vendor = this.vendorParams(params);
    const items = await collectAll<Asset>((page, pageSize) => this.fetchScopedPage(companyId, vendor, page, pageSize), this.companyPaginationOpts(vendor));
    if (groups.length === 0) return items;
    return this.withIncludesAll(items, groups, this.includePageSize(params));
  }

  /** `include` attaches the named relation groups to each asset in each page; keep before the plain overload (see `list`). */
  listPages(companyId: number, params: CompanyAssetsListParams & { include: AssetIncludeGroup[] }): AsyncIterable<Page<AssetWithIncludes>>;
  listPages(companyId: number, params?: CompanyAssetsListParams): AsyncIterable<Page<Asset>>;
  listPages(companyId: number, params?: CompanyAssetsListParams & { include?: AssetIncludeGroup[] }): AsyncIterable<Page<Asset> | Page<AssetWithIncludes>> {
    requireCompanyId(companyId, 'assets.listPages');
    const groups = validateIncludeGroups(params?.include, 'assets.listPages');
    const vendor = this.vendorParams(params);
    const base = paginate<Asset>((page, pageSize) => this.fetchScopedPage(companyId, vendor, page, pageSize), this.companyPaginationOpts(vendor));
    return groups.length === 0 ? base : this.withIncludesPages(base, groups, this.includePageSize(params));
  }

  async create(companyId: number, data: AssetCreate): Promise<Asset>;
  /** Dry-run: describe the create without issuing it. */
  async create(companyId: number, data: AssetCreate, opts: { dryRun: true }): Promise<DryRunResult<Asset>>;
  async create(companyId: number, data: AssetCreate, opts?: AssetWriteOptions): Promise<Asset | DryRunResult<Asset>>;
  /**
   * POST /companies/{companyId}/assets.
   * A-1/QA: the live n8n node and the PUT example wrap the body in { asset };
   * POST example in the spec is flat but the working live node wraps it too.
   * Live-verified (Hudu 2.45.1): the 201 response is `{ asset: {...} }`, so it is
   * unwrapped defensively by `unwrapCreated` — a bare record passes through unchanged.
   * `expectedUpdatedAt` is an UPDATE guard and cannot be honoured here, so it is refused
   * rather than silently ignored.
   */
  async create(companyId: number, data: AssetCreate, opts?: AssetWriteOptions): Promise<Asset | DryRunResult<Asset>> {
    const operation = 'assets.create';
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const company = requireCompanyId(companyId, operation);
    const path = `/companies/${company}/assets`;
    if (opts?.dryRun === true) {
      return this.buildDryRunResult<Asset>({
        operation,
        method: 'POST',
        path,
        checks: [this.payloadCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
      });
    }
    const body = await this.http.request<unknown>({ method: 'POST', path, body: { asset: data }, operation });
    return this.unwrapCreated<Asset>(body);
  }

  /** PUT /companies/{companyId}/assets/{id}. Wraps the body in { asset } — the api-docs.json PUT example and the live n8n node (_assetFieldUtils_ ~L522) both nest it; live-verified (Hudu 2.45.1) the 200 response is `{ asset: {...} }` too, so it is unwrapped by `unwrapSingle` (A-1/R6). */
  async update(companyId: number, id: number, data: AssetUpdate): Promise<Asset>;
  /** Dry-run: describe the update without issuing it. */
  async update(companyId: number, id: number, data: AssetUpdate, opts: { dryRun: true }): Promise<DryRunResult<Asset>>;
  async update(companyId: number, id: number, data: AssetUpdate, opts?: AssetWriteOptions): Promise<Asset | DryRunResult<Asset>>;
  /**
   * PUT /companies/{companyId}/assets/{id}. `{ dryRun: true }` describes the
   * update without issuing it. `staleCheck` is "unavailable" for assets: the
   * hand-rolled request path is not routed through `updateOne`, so no
   * `{ expectedUpdatedAt }` guard is offered — and because the guard cannot run,
   * the option is REFUSED with `HuduConfigError` (naming the operation) instead of
   * being silently dropped. Re-read the record's `updated_at` and compare it in the
   * caller before issuing the write.
   */
  async update(companyId: number, id: number, data: AssetUpdate, opts?: AssetWriteOptions): Promise<Asset | DryRunResult<Asset>> {
    const operation = 'assets.update';
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const company = requireCompanyId(companyId, operation);
    const path = `/companies/${company}/assets/${id}`;
    if (opts?.dryRun === true) {
      return this.buildDryRunResult<Asset>({
        operation,
        method: 'PUT',
        path,
        ids: [id],
        checks: [this.targetCheck(id), this.payloadCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
      });
    }
    const body = await this.http.request<unknown>({ method: 'PUT', path, body: { asset: data }, operation, resourceIds: [id] });
    return this.unwrapSingle<Asset>(body);
  }

  async delete(companyId: number, id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(companyId: number, id: number, opts: { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(companyId: number, id: number, opts?: AssetWriteOptions): Promise<void | DryRunResult<void>>;
  async delete(companyId: number, id: number, opts?: AssetWriteOptions): Promise<void | DryRunResult<void>> {
    const operation = 'assets.delete';
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const company = requireCompanyId(companyId, operation);
    const path = `/companies/${company}/assets/${id}`;
    if (opts?.dryRun === true) {
      return this.buildDryRunResult<void>({
        operation,
        method: 'DELETE',
        path,
        ids: [id],
        checks: [this.targetCheck(id)],
        affected: 1,
        scope: 'single',
        reversible: false,
        warnings: ['dry-run does not inspect dependent records'],
      });
    }
    await this.http.request<unknown>({ method: 'DELETE', path, operation, resourceIds: [id] });
  }

  async archive(companyId: number, id: number): Promise<void>;
  /** Dry-run: describe the archive without issuing it. */
  async archive(companyId: number, id: number, opts: { dryRun: true }): Promise<DryRunResult<void>>;
  async archive(companyId: number, id: number, opts?: AssetWriteOptions): Promise<void | DryRunResult<void>>;
  async archive(companyId: number, id: number, opts?: AssetWriteOptions): Promise<void | DryRunResult<void>> {
    return this.setArchivedScoped(companyId, id, true, opts);
  }

  async unarchive(companyId: number, id: number): Promise<void>;
  /** Dry-run: describe the unarchive without issuing it. */
  async unarchive(companyId: number, id: number, opts: { dryRun: true }): Promise<DryRunResult<void>>;
  async unarchive(companyId: number, id: number, opts?: AssetWriteOptions): Promise<void | DryRunResult<void>>;
  async unarchive(companyId: number, id: number, opts?: AssetWriteOptions): Promise<void | DryRunResult<void>> {
    return this.setArchivedScoped(companyId, id, false, opts);
  }

  async moveLayout(companyId: number, id: number, data: { asset_layout_id: number }): Promise<Asset>;
  /** Dry-run: describe the move without issuing it. */
  async moveLayout(companyId: number, id: number, data: { asset_layout_id: number }, opts: { dryRun: true }): Promise<DryRunResult<Asset>>;
  async moveLayout(companyId: number, id: number, data: { asset_layout_id: number }, opts?: AssetWriteOptions): Promise<Asset | DryRunResult<Asset>>;
  async moveLayout(companyId: number, id: number, data: { asset_layout_id: number }, opts?: AssetWriteOptions): Promise<Asset | DryRunResult<Asset>> {
    const operation = 'assets.moveLayout';
    refuseDryRunInPayload(operation, data);
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const company = requireCompanyId(companyId, operation);
    const path = `/companies/${company}/assets/${id}/move_layout`;
    if (opts?.dryRun === true) {
      return this.buildDryRunResult<Asset>({
        operation,
        method: 'PUT',
        path,
        ids: [id],
        checks: [this.targetCheck(id), this.payloadCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
        warnings: ['dry-run does not verify that the target layout exists'],
      });
    }
    const body = await this.http.request<unknown>({ method: 'PUT', path, body: data, operation, resourceIds: [id] });
    return this.unwrapSingle<Asset>(body);
  }

  /** `include` attaches the named relation groups to each asset (each group = its own fetch); keep before the plain overload (see `list`). */
  async listAllAcrossCompanies(params: AccountAssetsListParams & { include: AssetIncludeGroup[] }): Promise<AssetWithIncludes[]>;
  async listAllAcrossCompanies(params?: AccountAssetsListParams): Promise<Asset[]>;
  async listAllAcrossCompanies(params?: AccountAssetsListParams & { include?: AssetIncludeGroup[] }): Promise<Asset[] | AssetWithIncludes[]> {
    // The account-wide list accepts a `company_id` narrowing; a supplied one is
    // validated like a company-scoped path segment so a caller bug is named here.
    if (params !== undefined && 'company_id' in params) {
      requireCompanyId(params.company_id, 'assets.listAllAcrossCompanies');
    }
    const groups = validateIncludeGroups(params?.include, 'assets.listAllAcrossCompanies');
    const vendor = this.vendorParams(params);
    const items = await collectAll<Asset>((page, pageSize) => this.fetchAccountPage(vendor, page, pageSize), this.accountPaginationOpts(vendor));
    if (groups.length === 0) return items;
    return this.withIncludesAll(items, groups, this.includePageSize(params));
  }

  /** `include` attaches the named relation groups to each asset (each group = its own fetch); keep before the plain overload (see `list`). */
  listAcrossCompanies(params: AccountAssetsListParams & { include: AssetIncludeGroup[] }): AsyncIterable<AssetWithIncludes>;
  /** Stream account-wide assets across pages (GET /assets). */
  listAcrossCompanies(params?: AccountAssetsListParams): AsyncIterable<Asset>;
  listAcrossCompanies(params?: AccountAssetsListParams & { include?: AssetIncludeGroup[] }): AsyncIterable<Asset | AssetWithIncludes> {
    const groups = validateIncludeGroups(params?.include, 'assets.listAcrossCompanies');
    const vendor = this.vendorParams(params);
    const base = paginateItems<Asset>((page, pageSize) => this.fetchAccountPage(vendor, page, pageSize), this.accountPaginationOpts(vendor));
    return groups.length === 0 ? base : this.withIncludes(base, groups, this.includePageSize(params));
  }

  /** `include` attaches the named relation groups to each asset in each page; keep before the plain overload (see `list`). */
  listAcrossCompaniesPages(params: AccountAssetsListParams & { include: AssetIncludeGroup[] }): AsyncIterable<Page<AssetWithIncludes>>;
  /** Iterate account-wide asset pages (GET /assets). */
  listAcrossCompaniesPages(params?: AccountAssetsListParams): AsyncIterable<Page<Asset>>;
  listAcrossCompaniesPages(params?: AccountAssetsListParams & { include?: AssetIncludeGroup[] }): AsyncIterable<Page<Asset> | Page<AssetWithIncludes>> {
    const groups = validateIncludeGroups(params?.include, 'assets.listAcrossCompaniesPages');
    const vendor = this.vendorParams(params);
    const base = paginate<Asset>((page, pageSize) => this.fetchAccountPage(vendor, page, pageSize), this.accountPaginationOpts(vendor));
    return groups.length === 0 ? base : this.withIncludesPages(base, groups, this.includePageSize(params));
  }

  // ---------------------------------------------------------------------------
  // Agent-execution-layer helpers (policy §5-§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve an asset (policy §6). `{ companyId, id }` is the direct company-scoped
   * fetch; `{ id }` alone (or a numeric bare value) is resolved account-wide via
   * `GET /assets?id=`, and a miss throws `NOT_FOUND`, never `null`. Bare values are
   * read in the documented order: numeric id, primary_serial, name, slug. `null`
   * means a complete bounded scan found nothing; a scan stopped by the cap throws
   * `RESOLUTION_TRUNCATED`; several matches throw `RESOLUTION_AMBIGUOUS` with the
   * candidate ids in `resourceIds`.
   *
   * `limit` bounds the page size of a server-filtered scan; a direct company-scoped
   * `{ companyId, id }` fetch has nothing to scan, so `limit` has no effect there.
   */
  async resolve(identifier: number | string | AssetIdentifier): Promise<AssetSummary | null>;
  /** `expand: true` returns the full record. */
  async resolve(identifier: number | string | AssetIdentifier, opts: HelperOptions & { expand: true }): Promise<Asset | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async resolve(identifier: number | string | AssetIdentifier, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<AssetSummary>>;
  async resolve(
    identifier: number | string | AssetIdentifier,
    opts?: HelperOptions,
  ): Promise<AssetSummary | Asset | null | Resolution<AssetSummary>>;
  async resolve(
    identifier: number | string | AssetIdentifier,
    opts?: HelperOptions,
  ): Promise<AssetSummary | Asset | null | Resolution<AssetSummary>> {
    const resolution = await this.resolveRecord(identifier, opts);
    return projectResolution(resolution, opts, toAssetSummary) as AssetSummary | Asset | null | Resolution<AssetSummary>;
  }

  /** Resolve an asset account-wide by primary serial, with an exact compare (policy §6). */
  async findBySerial(serial: string): Promise<AssetSummary | null>;
  /** `expand: true` returns the full record. */
  async findBySerial(serial: string, opts: HelperOptions & { expand: true }): Promise<Asset | null>;
  /** `resolutionDetails: true` returns the `Resolution<T>` wrapper. */
  async findBySerial(serial: string, opts: HelperOptions & { resolutionDetails: true }): Promise<Resolution<AssetSummary>>;
  async findBySerial(serial: string, opts?: HelperOptions): Promise<AssetSummary | Asset | null | Resolution<AssetSummary>>;
  async findBySerial(serial: string, opts?: HelperOptions): Promise<AssetSummary | Asset | null | Resolution<AssetSummary>> {
    if (typeof serial !== 'string' || serial.trim().length === 0) {
      throw new HuduConfigError('assets.findBySerial requires a non-empty serial');
    }
    const resolution = await this.filterScan(
      { primary_serial: serial },
      (asset) => sameText(asset.primary_serial, serial),
      'assets.findBySerial',
      opts,
    );
    return projectResolution(resolution, opts, toAssetSummary) as AssetSummary | Asset | null | Resolution<AssetSummary>;
  }

  /**
   * Text search on the account-wide list (GET /assets), optionally narrowed with
   * `company_id`. `limit` defaults to 25 and is capped at 100 (a larger value
   * throws `HuduConfigError`).
   */
  async search(query: string): Promise<AssetSummary[]>;
  /** `expand: true` returns the full records. */
  async search(query: string, opts: { expand: true; limit?: number; company_id?: number; primary_serial?: string }): Promise<Asset[]>;
  /** `include` attaches the named relation groups to each compact summary (each group = its own fetch). */
  async search(query: string, opts: { include: AssetIncludeGroup[]; limit?: number; company_id?: number; primary_serial?: string }): Promise<AssetSummaryWithIncludes[]>;
  /** `expand: true` + `include` — full records, each carrying the named relation groups. */
  async search(query: string, opts: { expand: true; include: AssetIncludeGroup[]; limit?: number; company_id?: number; primary_serial?: string }): Promise<AssetWithIncludes[]>;
  async search(query: string, opts?: AssetSearchOptions & { include?: AssetIncludeGroup[] }): Promise<AssetSummary[] | Asset[] | AssetSummaryWithIncludes[] | AssetWithIncludes[]>;
  async search(query: string, opts?: AssetSearchOptions & { include?: AssetIncludeGroup[] }): Promise<AssetSummary[] | Asset[] | AssetSummaryWithIncludes[] | AssetWithIncludes[]> {
    const size = helperLimit(opts?.limit);
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new HuduConfigError('assets.search requires a non-empty query');
    }
    const groups = validateIncludeGroups(opts?.include, 'assets.search');
    const filter: Record<string, unknown> = { search: query };
    if (typeof opts?.company_id === 'number') filter.company_id = opts.company_id;
    if (typeof opts?.primary_serial === 'string' && opts.primary_serial.length > 0) {
      filter.primary_serial = opts.primary_serial;
    }
    const body = await this.request<unknown>({
      method: 'GET',
      path: '/assets',
      query: { ...filter, page: 1, page_size: size },
      operation: 'assets.search',
    });
    const items = this.unwrapList<Asset>(body).slice(0, size);
    if (groups.length === 0) return opts?.expand === true ? items : items.map(toAssetSummary);
    return opts?.expand === true
      ? this.withIncludesAll(items, groups, size)
      : this.withIncludesAll(items.map(toAssetSummary), groups, size);
  }

  /**
   * The asset plus its layout, expirations and relations (policy §9). Each part is
   * a bounded fetch driven by `limit` (default 25, max 100); a related record that
   * no longer exists is `null`, never an error.
   */
  async getContext(identifier: number | string | AssetIdentifier, opts?: { limit?: number }): Promise<AssetContext>;
  /** `expand: true` returns the full asset and layout records. */
  async getContext(identifier: number | string | AssetIdentifier, opts: { limit?: number; expand: true }): Promise<AssetContextExpand>;
  async getContext(identifier: number | string | AssetIdentifier, opts?: { limit?: number; expand?: boolean }): Promise<AssetContext | AssetContextExpand>;
  async getContext(
    identifier: number | string | AssetIdentifier,
    opts?: { limit?: number; expand?: boolean },
  ): Promise<AssetContext | AssetContextExpand> {
    const size = helperLimit(opts?.limit);
    if (typeof identifier === 'object' && identifier !== null && 'companyId' in identifier) {
      requireCompanyId(identifier.companyId, 'assets.getContext');
    }
    const resolution = await this.resolveRecord(identifier, opts);
    const asset = resolution.value;
    if (asset === null) {
      throw new NotFoundError('Asset was not found for assets.getContext', undefined, undefined, {
        operation: 'assets.getContext',
      });
    }
    const layoutId = typeof asset.asset_layout_id === 'number' && asset.asset_layout_id > 0 ? asset.asset_layout_id : undefined;
    const layout = layoutId === undefined ? null : await optionalGet(() => new AssetLayoutsResource(this.http).get(layoutId));
    const expirationParams = { company_id: asset.company_id, resource_id: asset.id, resource_type: 'Asset', page_size: size };
    const expirations = await take(new ExpirationsResource(this.http).list(expirationParams), size);
    const relationParams = { fromable_type: 'Asset', fromable_id: asset.id, page_size: size };
    const relations = await take(new RelationsResource(this.http).list(relationParams), size);
    if (opts?.expand === true) return { asset, layout, expirations, relations };
    return { asset: toAssetSummary(asset), layout, expirations, relations };
  }

  /** The identifier -> resolution table of `resolve` (policy §6). */
  private async resolveRecord(
    identifier: number | string | AssetIdentifier,
    opts?: HelperOptions,
  ): Promise<Resolution<Asset>> {
    if (typeof identifier === 'number') return this.byIdAccountWide(identifier);
    if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (text.length === 0) throw new HuduConfigError(ASSET_IDENTIFIER_KINDS);
      if (/^\d+$/.test(text)) return this.byIdAccountWide(Number(text));
      const bySerial = await this.filterScan({ primary_serial: text }, (asset) => sameText(asset.primary_serial, text), 'assets.resolve', opts);
      if (bySerial.value !== null) return bySerial;
      const byName = await this.filterScan({ name: text }, (asset) => sameText(asset.name, text), 'assets.resolve', opts);
      if (byName.value !== null) return byName;
      return this.filterScan({ slug: text }, (asset) => sameText(asset.slug, text), 'assets.resolve', opts);
    }
    if (identifier === null || typeof identifier !== 'object') throw new HuduConfigError(ASSET_IDENTIFIER_KINDS);
    const companyId = typeof identifier.companyId === 'number' ? identifier.companyId : undefined;
    // A supplied company scope is validated before it can reach a request path. The
    // key's PRESENCE is what counts: an explicitly supplied `undefined` is a caller
    // bug, while an omitted key means the account-wide identifiers below.
    if ('companyId' in identifier) requireCompanyId(identifier.companyId, 'assets.resolve');
    if (typeof identifier.id === 'number') {
      if (companyId !== undefined) return this.byIdScoped(companyId, identifier.id);
      return this.byIdAccountWide(identifier.id);
    }
    const narrowed = companyId === undefined ? {} : { company_id: companyId };
    if (typeof identifier.primary_serial === 'string') {
      return this.filterScan(
        { primary_serial: identifier.primary_serial, ...narrowed },
        (asset) => sameText(asset.primary_serial, identifier.primary_serial),
        'assets.resolve',
        opts,
      );
    }
    if (typeof identifier.name === 'string') {
      return this.filterScan({ name: identifier.name, ...narrowed }, (asset) => sameText(asset.name, identifier.name), 'assets.resolve', opts);
    }
    if (typeof identifier.slug === 'string') {
      return this.filterScan({ slug: identifier.slug, ...narrowed }, (asset) => sameText(asset.slug, identifier.slug), 'assets.resolve', opts);
    }
    throw new HuduConfigError(ASSET_IDENTIFIER_KINDS);
  }

  /** Direct company-scoped fetch: a miss throws NOT_FOUND (never null). */
  private async byIdScoped(companyId: number, id: number): Promise<Resolution<Asset>> {
    const asset = await this.get(companyId, id);
    return {
      value: asset,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
      candidates: [{ id: asset.id, label: assetLabel(asset) } satisfies ResolutionCandidate],
    };
  }

  /**
   * Account-wide `{ id }` lookup (GET /assets?id=). A miss — including a complete
   * scan that returned nothing — throws NOT_FOUND, never null (policy §6).
   */
  private async byIdAccountWide(id: number, companyId?: number): Promise<Resolution<Asset>> {
    const filter: Record<string, unknown> = companyId === undefined ? { id } : { id, company_id: companyId };
    const resolution = await this.filterScan(filter, (asset) => asset.id === id, 'assets.resolve');
    if (resolution.value === null) {
      throw new NotFoundError(`No asset with id ${id} was returned by GET /assets?id=${id}`, undefined, undefined, {
        operation: 'assets.resolve',
        resourceIds: [id],
      });
    }
    return resolution;
  }

  /**
   * One bounded, server-filtered scan (policy §6) on the account-wide list. Several
   * matches throw `RESOLUTION_AMBIGUOUS`; a scan stopped by the cap throws
   * `RESOLUTION_TRUNCATED` (never `null`); a complete scan with no match is `null`.
   */
  private async filterScan(
    filter: Record<string, unknown>,
    matches: (asset: Asset) => boolean,
    operation: string,
    opts?: HelperOptions,
  ): Promise<Resolution<Asset>> {
    const size = helperLimit(opts?.limit);
    const fetched: Asset[] = [];
    const scan = await this.boundedScan<Asset>(
      async (page) => {
        const body = await this.request<unknown>({
          method: 'GET',
          path: '/assets',
          query: { ...filter, page, page_size: size },
          operation,
        });
        const items = this.unwrapList<Asset>(body);
        return { items, page, page_size: size, hasMore: items.length === size };
      },
      {
        match: (asset) => {
          fetched.push(asset);
          return false;
        },
        label: assetLabel,
        resolutionCost: 'server-filter',
      },
    );
    const exact = fetched.filter(matches);
    if (exact.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: ${exact.length} assets match the identifier exactly, so it is not unique.`,
        { operation, resourceIds: exact.map((asset) => asset.id) },
      );
    }
    // A cap that stopped the scan cannot prove uniqueness: a single exact match must not be
    // handed back as a confident hit, so the shared guard throws RESOLUTION_TRUNCATED (policy §6).
    assertScanDecided({ operation, scanned: fetched.length, truncated: scan.scanTruncated });
    const only = exact.length === 1 ? (exact[0] as Asset) : undefined;
    if (only !== undefined) {
      return {
        value: only,
        resolutionCost: 'server-filter',
        scanned: fetched.length,
        scanTruncated: false,
        candidates: [{ id: only.id, label: assetLabel(only) } satisfies ResolutionCandidate],
      };
    }
    if (fetched.length > 1) {
      throw ResolutionError.ambiguous(
        `${operation}: the vendor filter is inexact and returned ${fetched.length} assets, none matching exactly.`,
        { operation, resourceIds: fetched.map((asset) => asset.id) },
      );
    }
    return { value: null, resolutionCost: 'server-filter', scanned: fetched.length, scanTruncated: false };
  }

  /** PUT archive/unarchive for a company-scoped asset, with the dry-run overloads. */
  private async setArchivedScoped(
    companyId: number,
    id: number,
    archive: boolean,
    opts?: AssetWriteOptions,
  ): Promise<void | DryRunResult<void>> {
    const action = archive ? 'archive' : 'unarchive';
    const operation = `assets.${action}`;
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const company = requireCompanyId(companyId, operation);
    const path = `/companies/${company}/assets/${id}/${action}`;
    if (opts?.dryRun === true) {
      return this.buildDryRunResult<void>({
        operation,
        method: 'PUT',
        path,
        ids: [id],
        checks: [this.targetCheck(id)],
        affected: 1,
        scope: 'single',
        reversible: true,
      });
    }
    await this.http.request<unknown>({ method: 'PUT', path, operation, resourceIds: [id] });
  }

  /**
   * Extract the caller's `page`/`page_size` from account-wide list params and
   * thread them as PaginateOptions into the raw pagination helpers (mirrors
   * BaseResource.paginationOpts, but here the account-wide fetchers call the
   * raw collectAll/paginateItems/paginate directly). Without this, the helpers
   * would start at page 1 with the default page_size 25, silently swallowing a
   * caller's `page`/`page_size`.
   */
  private companyPaginationOpts(params?: ListParams): PaginateOptions {
    const page = typeof params?.page === 'number' ? params.page : undefined;
    const page_size = typeof params?.page_size === 'number' ? params.page_size : undefined;
    // Enable the content-based no-progress guard (mirrors accountPaginationOpts).
    return { page, page_size, guardNoProgress: true };
  }

  private accountPaginationOpts(params?: ListParams): PaginateOptions {
    const page = typeof params?.page === 'number' ? params.page : undefined;
    const page_size = typeof params?.page_size === 'number' ? params.page_size : undefined;
    // codex PR review [15]: enable the content-based no-progress guard so a
    // server that ignores `page` (repeats the same full page) yields an error
    // instead of duplicate items / a 100k-request loop.
    return { page, page_size, guardNoProgress: true };
  }

  private async fetchScopedPage(companyId: number, params: ListParams, page: number, pageSize: number) {
    const body = await this.http.request<unknown>({ method: 'GET', path: `/companies/${companyId}/assets`, query: { ...params, page, page_size: pageSize }, operation: 'assets.list' });
    const items = this.unwrapList<Asset>(body);
    return { items, page, page_size: pageSize, hasMore: items.length === pageSize };
  }

  private async fetchAccountPage(params: ListParams, page: number, pageSize: number) {
    // `page`/`pageSize` come from the thread-through PaginateOptions; spread
    // params first so any caller-supplied page/page_size are overlaid by the
    // effective looper values (which now honour the caller's page/page_size).
    const body = await this.http.request<unknown>({ method: 'GET', path: `/assets`, query: { ...params, page, page_size: pageSize }, operation: 'assets.listAcrossCompanies' });
    const items = this.unwrapList<Asset>(body);
    return { items, page, page_size: pageSize, hasMore: items.length === pageSize };
  }

  // ---------------------------------------------------------------------------
  // `include` groups (issue #24): opt-in relation groups on the list-shaped calls.
  // Each named group triggers ONLY its own extra fetch; an unrequested group is
  // never fetched. `include` is an SDK option, never a vendor query param.
  // ---------------------------------------------------------------------------

  /** Strip the SDK-only `include` option so it never reaches the vendor as a query param. */
  private vendorParams<T extends ListParams>(params: (T & { include?: readonly string[] }) | undefined): T {
    if (params === undefined) return {} as T;
    const rest: Record<string, unknown> = { ...params };
    delete rest.include;
    return rest as T;
  }

  /** The effective page size for the per-group fetches (the list's page_size, default 25). */
  private includePageSize(params: { page_size?: number } | undefined): number {
    return typeof params?.page_size === 'number' ? params.page_size : DEFAULT_PAGE_SIZE;
  }

  /** Wrap an item stream, attaching the named groups to each asset as it is yielded. */
  private async *withIncludes(
    items: AsyncIterable<Asset>,
    groups: AssetIncludeGroup[],
    pageSize: number,
  ): AsyncGenerator<AssetWithIncludes> {
    for await (const item of items) {
      yield { ...item, ...(await this.fetchAssetIncludes(item, groups, pageSize)) };
    }
  }

  /** Wrap a page stream, attaching the named groups to each asset in each page. */
  private async *withIncludesPages(
    pages: AsyncIterable<Page<Asset>>,
    groups: AssetIncludeGroup[],
    pageSize: number,
  ): AsyncGenerator<Page<AssetWithIncludes>> {
    for await (const page of pages) {
      const items = await this.withIncludesAll(page.items, groups, pageSize);
      yield { ...page, items };
    }
  }

  /** Attach the named groups to a collected array of assets (or summaries). */
  private async withIncludesAll<T extends AssetIncludeSource>(
    items: T[],
    groups: AssetIncludeGroup[],
    pageSize: number,
  ): Promise<(T & AssetIncludes)[]> {
    return Promise.all(items.map(async (item) => ({ ...item, ...(await this.fetchAssetIncludes(item, groups, pageSize)) })));
  }

  /** Fetch the named groups for one asset, in parallel; each group is its own fetch. */
  private async fetchAssetIncludes(asset: AssetIncludeSource, groups: AssetIncludeGroup[], pageSize: number): Promise<AssetIncludes> {
    const results = await Promise.all(
      groups.map(async (group): Promise<Partial<AssetIncludes>> => {
        switch (group) {
          case 'layout': return this.fetchLayoutInclude(asset);
          case 'expirations': return this.fetchExpirationsInclude(asset, pageSize);
          case 'relations': return this.fetchRelationsInclude(asset, pageSize);
          case 'photos': return this.fetchPhotosInclude(asset, pageSize);
        }
      }),
    );
    return Object.assign({}, ...results);
  }

  /** `layout` group: the asset's layout as a compact summary, or null when it has none. */
  private async fetchLayoutInclude(asset: AssetIncludeSource): Promise<Partial<AssetIncludes>> {
    const layoutId = typeof asset.asset_layout_id === 'number' && asset.asset_layout_id > 0 ? asset.asset_layout_id : null;
    if (layoutId === null) return { layout: null };
    const layout = await optionalGet(() => new AssetLayoutsResource(this.http).get(layoutId));
    return { layout: layout === null ? null : toAssetLayoutSummary(layout) };
  }

  /** `expirations` group: the asset's expirations as compact summaries (one bounded page). */
  private async fetchExpirationsInclude(asset: AssetIncludeSource, pageSize: number): Promise<Partial<AssetIncludes>> {
    const params = { company_id: asset.company_id, resource_id: asset.id, resource_type: 'Asset', page_size: pageSize };
    const items = await take(new ExpirationsResource(this.http).list(params), pageSize);
    return { expirations: items.map(toExpirationSummary) };
  }

  /** `relations` group: the asset's outgoing relations as compact summaries (one bounded page). */
  private async fetchRelationsInclude(asset: AssetIncludeSource, pageSize: number): Promise<Partial<AssetIncludes>> {
    const params = { fromable_type: 'Asset', fromable_id: asset.id, page_size: pageSize };
    const items = await take(new RelationsResource(this.http).list(params), pageSize);
    return { relations: items.map(toRelationSummary) };
  }

  /** `photos` group: the asset's photos as compact summaries (one bounded page). */
  private async fetchPhotosInclude(asset: AssetIncludeSource, pageSize: number): Promise<Partial<AssetIncludes>> {
    const params = { photoable_type: 'Asset', photoable_id: asset.id, page_size: pageSize };
    const items = await take(new PhotosResource(this.http).list(params), pageSize);
    return { photos: items.map(toPhotoSummary) };
  }
}
