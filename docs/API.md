# node-hudu — API Reference

> Generated from the actual TypeScript source under `src/`. Method names, parameter
> ordering, and return types below match the `.ts` files exactly. All resource methods
> return **plain typed data**; `listAll()` is the recommended MCP read.

## Table of contents

- [Installation & construction](#installation--construction)
- [Config, pagination & error types](#config-pagination--error-types)
- [Resource clients](#resource-clients)
  - [CompaniesResource](#companiesresource)
  - [ArticlesResource](#articlesresource)
  - [AssetLayoutsResource](#assetlayoutsresource)
  - [AssetPasswordsResource](#assetpasswordsresource)
  - [AssetsResource](#assetsresource)
  - [ExpirationsResource](#expirationsresource)
  - [ExportsResource](#exportsresource)
  - [FlagTypesResource](#flagtypesresource)
  - [FlagsResource](#flagsresource)
  - [FoldersResource](#foldersresource)
  - [GroupsResource](#groupsresource)
  - [IpAddressesResource](#ipaddressesresource)
  - [LabelTypesResource](#labeltypesresource)
  - [LabelsResource](#labelsresource)
  - [ListsResource](#listsresource)
  - [MagicDashResource](#magicdashresource)
  - [MatchersResource](#matchersresource)
  - [NetworksResource](#networksresource)
  - [PasswordFoldersResource](#passwordfoldersresource)
  - [PhotosResource](#photosresource)
  - [ProcedureTasksResource](#proceduretasksresource)
  - [ProceduresResource](#proceduresresource)
  - [PublicPhotosResource](#publicphotosresource)
  - [RackStorageItemsResource](#rackstorageitemsresource)
  - [RackStoragesResource](#rackstoragesresource)
  - [RelationsResource](#relationsresource)
  - [S3ExportsResource](#s3exportsresource)
  - [UploadsResource](#uploadsresource)
  - [UsersResource](#usersresource)
  - [VlanZonesResource](#vlanzonesresource)
  - [VlansResource](#vlansresource)
  - [WebsitesResource](#websitesresource)
  - [ApiInfoResource](#apiinforesource)
  - [ActivityLogsResource](#activitylogsresource)
  - [CardsResource](#cardsresource)

---

## Installation & construction

```bash
npm install node-hudu
```

The primary entry point constructs a `HuduClient` and wires up **35 resource clients**
as instance fields (e.g. `hudu.companies`, `hudu.assets`, `hudu.activityLogs`).

```ts
import { HuduClient } from 'node-hudu';

const hudu = new HuduClient({
  baseUrl: 'https://hudu.example.com',
  apiKey: process.env.HUDU_API_KEY!,
});
```

All type-only imports come from the package root too:

```ts
import type { Company, Asset, Page, ListParams } from 'node-hudu';
import { HuduError, NotFoundError, RateLimitError } from 'node-hudu';
```

For advanced use you can build a resource from a standalone `HttpClient`:

```ts
import { HttpClient, CompaniesResource, resolveConfig } from 'node-hudu';

const http = new HttpClient(resolveConfig({ baseUrl, apiKey }));
const companies = new CompaniesResource(http);
```

---

## Config, pagination & error types

### `HuduConfig` (input) / `ResolvedConfig`

```ts
export interface HuduConfig {
  /** Origin only, e.g. 'https://hudu.example.com'. No path, no trailing slash. */
  baseUrl: string;
  /** Hudu API key. Required unless `auth` is set - supply exactly one of the two. */
  apiKey?: string;
  /** Pluggable credential source: `ApiKeyAuth`, `BearerTokenAuth`, `HeaderAuth`, or your own. */
  auth?: AuthStrategy;
  /** Defaults to '/api/v1' — the Swagger base path. */
  basePath?: string;
  /** HTTP timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Retry budget for idempotent requests (GET/PUT/DELETE) on 429/5xx. Default 3 (0 disables). */
  maxRetries?: number;
  /** Optional request log sink. */
  logger?: Logger;
  /** Optional client-side rate limiter (token bucket). Off by default. */
  rateLimit?: RateLimitConfig;
}

export interface RateLimitConfig {
  /** Max requests per minute. Default 300 (Hudu's documented limit). Must be > 0. */
  perMinute?: number;
  /** Optional max burst beyond steady rate. Default equals perMinute. */
  burst?: number;
}

/** Exported constants */
export const DEFAULT_BASE_PATH = '/api/v1';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 300;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_PAGE_SIZE = 25;
```

`ConfigError` conditions: `baseUrl` must be an `http:`/`https:` origin (no path); `apiKey`
must be a non-empty string; exactly one of `apiKey`/`auth` must be supplied, so both set, a
non-strategy `auth`, or neither is also a `ConfigError`; a built-in strategy constructor refuses a
blank credential, and `withAuth` refuses an empty string or a non-strategy; `basePath` must start
with `/`; `timeoutMs` must be a **positive** integer (`0` is rejected — a zero timeout would abort
every request immediately) while `maxRetries` must be a non-negative integer; `rateLimit.perMinute`
must be a positive integer.

### Pagination

```ts
export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  hasMore: boolean;
}

export interface ListParams {
  page?: number;
  page_size?: number;
  [key: string]: unknown; // resource-specific filters
}

// Standalone helpers
export function paginate<T>(fetchPage: (page: number, pageSize: number) => Promise<Page<T>>): AsyncGenerator<Page<T>>;
export function paginateItems<T>(fetchPage: (page: number, pageSize: number) => Promise<Page<T>>): AsyncGenerator<T>;
export function collectAll<T>(fetchPage: (page: number, pageSize: number) => Promise<Page<T>>): Promise<T[]>;
export function toArray<T>(iter: AsyncIterable<T>): Promise<T[]>;
```

**Reading semantics per resource** (driven by each resource's `paginated` flag):

| Capability | `list()` | `listPages()` | `listAll()` |
|------------|----------|---------------|-------------|
| `paginated: true` | stream items across pages | stream `Page<T>` objects | collect all pages → `T[]` |
| `paginated: false` | single list (one page) | single-page iterator | the whole list → `T[]` |

Non-paginated resources: `exports` and `s3_exports` are handled specially, and the
following list endpoints do **not** paginate (single call): `ip_addresses`, `lists`,
`networks`, `procedure_tasks`, `rack_storage_items`, `rack_storages`, `vlan_zones`,
`vlans`.

### Errors

```ts
export class HuduError extends Error {
  readonly status?: number;
  readonly code: string;      // machine-readable, e.g. 'NOT_FOUND'
  readonly url?: string;
  readonly body?: unknown;
}
export class HuduConfigError extends HuduError { /* code: 'CONFIG_ERROR' */ }
export class AuthError extends HuduError { /* code: 'AUTH_ERROR', category 'auth', not retryable */ }
export class HuduNetworkError extends HuduError { /* code: 'NETWORK_ERROR' */ }
export class BadRequestError extends HuduError { /* status 400, code 'BAD_REQUEST' */ }
export class UnauthorizedError extends HuduError { /* 401 'UNAUTHORIZED' */ }
export class ForbiddenError extends HuduError { /* 403 'FORBIDDEN' */ }
export class NotFoundError extends HuduError { /* 404 'NOT_FOUND' */ }
export class MethodNotAllowedError extends HuduError { /* 405 'METHOD_NOT_ALLOWED' */ }
export class NotAcceptableError extends HuduError { /* 406 'NOT_ACCEPTABLE' */ }
export class UnprocessableEntityError extends HuduError { /* 422 'UNPROCESSABLE_ENTITY' */ }
export class RateLimitError extends HuduError { readonly retryAfter?: number; /* 429 'RATE_LIMIT' */ }
export class ServerError extends HuduError { /* 5xx 'SERVER_ERROR' */ }

export function errorFromStatus(status: number, body: unknown, url?: string): HuduError;
export function isHuduError(err: unknown): err is HuduError;
```

### HTTP transport

```ts
// EXCERPT - the full `RequestOptions` in `src/http.ts` also declares `formUrlEncoded`,
// `responseType`, `manualRedirect`, `operation`, `resourceIds`, `dryRun` and `impact`.
export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;                         // after basePath, e.g. '/companies/{id}'
  query?: Record<string, unknown>;
  body?: unknown;
  formData?: FormData;                  // multipart (photos, public_photos, uploads)
  headers?: Record<string, string>;     // wins over the strategy's credential headers (see Auth below)
  accept?: string;                      // override Accept (e.g. 'text/html' for redirects)
  retries?: boolean;                    // default true; POST is never retried
  auth?: AuthStrategy;                  // per-request credential override; defaults to config.auth
}
export class HttpClient {
  /** `state` is the shared transport state (rate-limit bucket, queue, in-flight counters). It is
   *  optional and normally omitted; `withAuth()` passes the parent's state so scopes share one rate
   *  budget. `TransportState` is exported by `src/http.ts`, not from the package root. */
  constructor(config: ResolvedConfig, state?: TransportState);
  request<T>(opts: RequestOptions): Promise<T>;
  resolveRedirect(path: string, query?: Record<string, unknown>, headers?: Record<string, string>): Promise<string>;
}
```

Auth is a header strategy. The default produces the Hudu `x-api-key` header; a deployment that fronts
Hudu with a bearer-accepting proxy uses `BearerTokenAuth`. Hudu's own API document defines only
`APIKeyHeader`, so the SDK never performs an OAuth or token exchange - it only produces headers.

```ts
export const API_KEY_HEADER = 'x-api-key';
export function buildAuthHeaders(apiKey: string): Record<string, string>;
export function withAuth(headers: Record<string,string> | undefined, apiKey: string): Record<string,string>;

export interface AuthContext {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;                // after basePath, e.g. '/companies/42'
  readonly url: string;                 // absolute, query string stripped
  readonly correlationId: string;       // one per call, identical on every attempt
  readonly attempt: number;             // 0 on the first attempt
}
export type AuthHeaders = Record<string, string>;

export interface AuthStrategy {
  readonly name: string;                // short label used in error messages, e.g. 'api-key'
  headers(ctx: AuthContext): AuthHeaders | Promise<AuthHeaders>;
  readonly secretHeaders?: readonly string[];   // extra header NAMES to redact in audit events
}

export class ApiKeyAuth implements AuthStrategy { constructor(apiKey: string); }        // x-api-key
export class BearerTokenAuth implements AuthStrategy { constructor(token: string); }    // Authorization: Bearer
export class HeaderAuth implements AuthStrategy {
  constructor(headers: Record<string, string>, options?: { name?: string; secretHeaders?: readonly string[] });
}
```

`HuduConfig` accepts exactly one of `apiKey` / `auth`; `ResolvedConfig.auth` is always present, and
`ResolvedConfig.apiKey` is `''` when a strategy is used. A strategy's `headers(ctx)` is called at most
once per **attempt** (never for `{ dryRun: true }` and never at construction), so a retry after
backoff can pick up a rotated credential; `ctx.correlationId` lets a strategy cache one lookup per
call. The SDK caches nothing itself.

**Header precedence (credential vs caller `headers`).** Each attempt builds one header map by merging
in this fixed order, where a **later writer wins**:

| Order | Source |
|-------|--------|
| 1 | the credential headers the strategy produced |
| 2 | the caller's `RequestOptions.headers` |
| 3 | `Accept` (`opts.accept`, else the `application/json` default) |
| 4 | `Content-Type` (derived from `body` / `formUrlEncoded`) |

A caller-supplied `headers` value therefore **overrides** the credential the strategy produced and can
suppress it entirely - never forward untrusted headers into `headers`. Header names are
case-insensitive, so duplicate names that differ only in case collapse to ONE value: the later writer's
value, under its own spelling (the earlier duplicate is dropped, not combined).

```ts
// On HuduClient - a scoped client: same transport state (rate-limit bucket, queue, logger, audit
// hook, timeouts), other credential. Throws CONFIG_ERROR for an empty string or a non-strategy.
class HuduClient {
  withAuth(strategyOrToken: AuthStrategy | string): HuduClient;
}
```

A bare string is an **API key** (`ApiKeyAuth`), never a bearer token. A scoped client is a real
`HuduClient`: `instanceof` holds, every resource method is available, and `getRateLimitStatus()`
reports the shared counters.

If a credential cannot be produced for an attempt - `headers(ctx)` throws, returns a blank or
non-string value, or does not settle inside the call's remaining `timeoutMs` - the call throws
`AuthError` (`AUTH_ERROR`, category `auth`, not retryable) and no request is sent. A 401 from the
server is still `UnauthorizedError`; a 403 is still `ForbiddenError`.

---

## Resource clients

Conventions used below: `LP` = that resource's `<Resource>ListParams` type, `TCreate` /
`TUpdate` = `<Type>Create` / `<Type>Update` input types. Every method marked
`async` returns a `Promise`; `list`/`listPages` return `AsyncIterable`.

### CompaniesResource

```ts
class CompaniesResource {
  get(id: number): Promise<Company>;
  list(params?: CompaniesListParams): AsyncIterable<Company>;
  listPages(params?: CompaniesListParams): AsyncIterable<Page<Company>>;
  listAll(params?: CompaniesListParams): Promise<Company[]>;
  create(data: CompanyCreate): Promise<Company>;          // raw create
  update(id: number, data: CompanyUpdate): Promise<Company>;
  delete(id: number): Promise<void>;                      // 204/empty
  archive(id: number): Promise<void>;
  unarchive(id: number): Promise<void>;
}
// CompaniesListParams = ListParams & {
//   name?: string; phone_number?: string; website?: string; city?: string;
//   id_number?: string; state?: string; slug?: string; search?: string;
//   id_in_integration?: string; updated_at?: string;
// }
```

### ArticlesResource

```ts
class ArticlesResource {
  get(id: number): Promise<Article>;
  list(params?: ArticlesListParams): AsyncIterable<Article>;
  listPages(params?: ArticlesListParams): AsyncIterable<Page<Article>>;
  listAll(params?: ArticlesListParams): Promise<Article[]>;
  create(data: ArticleCreate): Promise<Article>;          // raw
  update(id: number, data: ArticleUpdate): Promise<Article>;
  delete(id: number): Promise<void>;
  archive(id: number): Promise<void>;
  unarchive(id: number): Promise<void>;
}
// ArticlesListParams = ListParams & {
//   name?: string; company_id?: number; draft?: boolean; enable_sharing?: boolean;
//   slug?: string; search?: string; updated_at?: string;
// }
```

### AssetLayoutsResource

```ts
class AssetLayoutsResource {
  get(id: number): Promise<AssetLayout>;
  list(params?: AssetLayoutsListParams): AsyncIterable<AssetLayout>;
  listPages(params?: AssetLayoutsListParams): AsyncIterable<Page<AssetLayout>>;
  listAll(params?: AssetLayoutsListParams): Promise<AssetLayout[]>;
  create(data: AssetLayoutCreate): Promise<AssetLayout>;  // wrapped
  update(id: number, data: AssetLayoutUpdate): Promise<AssetLayout>;
  // no delete — the API has no DELETE for asset layouts
}
// AssetLayoutsListParams = ListParams & { name?: string; slug?: string; active?: boolean; updated_at?: string }
```

### AssetPasswordsResource

```ts
class AssetPasswordsResource {
  get(id: number): Promise<AssetPassword>;
  list(params?: AssetPasswordsListParams): AsyncIterable<AssetPassword>;
  listPages(params?: AssetPasswordsListParams): AsyncIterable<Page<AssetPassword>>;
  listAll(params?: AssetPasswordsListParams): Promise<AssetPassword[]>;
  create(data: AssetPasswordCreate): Promise<AssetPassword>;  // wrapped
  update(id?: number, data: AssetPasswordUpdate): Promise<AssetPassword>;
  delete(id: number): Promise<void>;
  archive(id: number): Promise<void>;
  unarchive(id: number): Promise<void>;
}
// AssetPasswordsListParams = ListParams & {
//   name?: string; company_id?: number; archived?: boolean; slug?: string; search?: string; updated_at?: string
// }
```

### AssetsResource

Company-scoped: base path `companies/{companyId}/assets`. All methods take `companyId`
first, plus account-wide `listAllAcrossCompanies`.

```ts
class AssetsResource {
  get(companyId: number, id: number): Promise<Asset>;
  list(companyId: number, params?: CompanyAssetsListParams): AsyncIterable<Asset>;
  listPages(companyId: number, params?: CompanyAssetsListParams): AsyncIterable<Page<Asset>>;
  listAll(companyId: number, params?: CompanyAssetsListParams): Promise<Asset[]>;
  create(companyId: number, data: AssetCreate): Promise<Asset>;   // raw
  update(companyId: number, id: number, data: AssetUpdate): Promise<Asset>;
  delete(companyId: number, id: number): Promise<void>;
  archive(companyId: number, id: number): Promise<void>;
  unarchive(companyId: number, id: number): Promise<void>;
  moveLayout(companyId: number, id: number, data: { asset_layout_id: number }): Promise<Asset>;
  // Account-wide (GET /assets):
  listAllAcrossCompanies(params?: AccountAssetsListParams): Promise<Asset[]>;
  listAcrossCompanies(params?: AccountAssetsListParams): AsyncIterable<Asset>;
  listAcrossCompaniesPages(params?: AccountAssetsListParams): AsyncIterable<Page<Asset>>;
}
// CompanyAssetsListParams = ListParams & { archived?: boolean }
// AccountAssetsListParams = ListParams & {
//   company_id?: number; id?: number; name?: string; primary_serial?: string;
//   asset_layout_id?: number; archived?: boolean; slug?: string; search?: string; updated_at?: string
// }
```

### ExpirationsResource

No single `get`, no `create`.

```ts
class ExpirationsResource {
  list(params?: ExpirationsListParams): AsyncIterable<Expiration>;
  listPages(params?: ExpirationsListParams): AsyncIterable<Page<Expiration>>;
  listAll(params?: ExpirationsListParams): Promise<Expiration[]>;
  update(id: number, data: ExpirationUpdate): Promise<Expiration>;
  delete(id: number): Promise<void>;
}
// ExpirationsListParams = ListParams & {
//   company_id?: number; expiration_type?: string; resource_id?: number; resource_type?: string; archived?: boolean
// }
```

### ExportsResource

Non-paginated. `create` initiates an export (HTTP 200, empty body); `get` with
`download: true` returns a `Blob`.

```ts
class ExportsResource {
  list(params?: ExportsListParams): AsyncIterable<Export>;
  listPages(params?: ExportsListParams): AsyncIterable<Page<Export>>;
  listAll(params?: ExportsListParams): Promise<Export[]>;
  create(data: ExportCreate): Promise<void>;
  get(id: number, opts?: { download?: boolean }): Promise<Export | Blob>;
}
// ExportsListParams = ListParams  (no extra filters)
```

### FlagTypesResource

```ts
class FlagTypesResource {
  get(id: number): Promise<FlagType>;
  list(params?: FlagTypesListParams): AsyncIterable<FlagType>;
  listPages(params?: FlagTypesListParams): AsyncIterable<Page<FlagType>>;
  listAll(params?: FlagTypesListParams): Promise<FlagType[]>;
  create(data: FlagTypeCreate): Promise<FlagType>;   // wrapped
  update(id: number, data: FlagTypeUpdate): Promise<FlagType>;
  delete(id: number): Promise<void>;
}
// FlagTypesListParams = ListParams & { name: string; color: string; slug: string; created_at: string; updated_at: string }
```

### FlagsResource

```ts
class FlagsResource {
  get(id: number): Promise<Flag>;
  list(params?: FlagsListParams): AsyncIterable<Flag>;
  listPages(params?: FlagsListParams): AsyncIterable<Page<Flag>>;
  listAll(params?: FlagsListParams): Promise<Flag[]>;
  create(data: FlagCreate): Promise<Flag>;            // wrapped
  update(id?: number, data: FlagUpdate): Promise<Flag>;
  delete(id: number): Promise<void>;
}
// FlagsListParams = ListParams & {
//   flag_type_id?: number; flagable_type?: string; flagable_id?: number; description?: string;
//   created_at?: string; updated_at?: string
// }
```

### FoldersResource

```ts
class FoldersResource {
  get(id: number): Promise<Folder>;
  list(params?: FoldersListParams): AsyncIterable<Folder>;
  listPages(params?: FoldersListParams): AsyncIterable<Page<Folder>>;
  listAll(params?: FoldersListParams): Promise<Folder[]>;
  create(data: FolderCreate): Promise<Folder>;        // wrapped
  update(id: number, data: FolderUpdate): Promise<Folder>;
  delete(id: number): Promise<void>;
}
// FoldersListParams = ListParams & { name: string; company_id: number; in_company: boolean; folder_type: string }
```

### GroupsResource

Read-only.

```ts
class GroupsResource {
  get(id: number): Promise<Group>;
  list(params?: GroupsListParams): AsyncIterable<Group>;
  listPages(params?: GroupsListParams): AsyncIterable<Page<Group>>;
  listAll(params?: GroupsListParams): Promise<Group[]>;
}
// GroupsListParams = ListParams & { name?: string; default?: boolean; search?: string }
```

### IpAddressesResource

Non-paginated (`paginated: false`).

```ts
class IpAddressesResource {
  get(id: number): Promise<IpAddress>;
  list(params?: IpAddressesListParams): AsyncIterable<IpAddress>;
  listPages(params?: IpAddressesListParams): AsyncIterable<Page<IpAddress>>;
  listAll(params?: IpAddressesListParams): Promise<IpAddress[]>;
  create(data: IpAddressCreate): Promise<IpAddress>;  // raw
  update(id?: number, data: IpAddressUpdate): Promise<IpAddress>;
  delete(id: number): Promise<void>;
}
// IpAddressesListParams = ListParams & {
//   network_id?: number; address?: string; status?: string; fqdn?: string; asset_id?: number;
//   company_id?: number; created_at?: string; updated_at?: string
// }
```

### LabelTypesResource

```ts
class LabelTypesResource {
  get(id: number): Promise<LabelType>;
  list(params?: LabelTypesListParams): AsyncIterable<LabelType>;
  listPages(params?: LabelTypesListParams): AsyncIterable<Page<LabelType>>;
  listAll(params?: LabelTypesListParams): Promise<LabelType[]>;
  create(data: LabelTypeCreate): Promise<LabelType>;  // wrapped
  update(id: number, data: LabelTypeUpdate): Promise<LabelType>;
  delete(id: number): Promise<void>;
}
// LabelTypesListParams = ListParams & { name: string; color: string; slug: string; created_at: string; updated_at: string }
```

### LabelsResource

```ts
class LabelsResource {
  get(id: number): Promise<Label>;
  list(params?: LabelsListParams): AsyncIterable<Label>;
  listPages(params?: LabelsListParams): AsyncIterable<Page<Label>>;
  listAll(params?: LabelsListParams): Promise<Label[]>;
  create(data: LabelCreate): Promise<Label>;          // wrapped
  update(id?: number, data: LabelUpdate): Promise<Label>;
  delete(id: number): Promise<void>;
}
// LabelsListParams = ListParams & {
//   label_type_id?: number; labelable_type?: string; labelable_id?: number; user_id?: number;
//   created_at?: string; updated_at?: string
// }
```

### ListsResource

Non-paginated (`paginated: false`).

```ts
class ListsResource {
  get(id: number): Promise<List>;
  list(params?: ListsListParams): AsyncIterable<List>;
  listPages(params?: ListsListParams): AsyncIterable<Page<List>>;
  listAll(params?: ListsListParams): Promise<List[]>;
  create(data: ListCreate): Promise<List>;            // raw
  update(id: number, data: ListUpdate): Promise<List>;
  delete(id: number): Promise<void>;
}
// ListsListParams = ListParams & { query: string; name: string }
```

### MagicDashResource

```ts
class MagicDashResource {
  list(params?: MagicDashListParams): AsyncIterable<MagicDash>;
  listPages(params?: MagicDashListParams): AsyncIterable<Page<MagicDash>>;
  listAll(params?: MagicDashListParams): Promise<MagicDash[]>;
  create(data: MagicDashCreate): Promise<MagicDash>;  // raw; POST may create or update
  delete(data: { title: string; company_name: string }): Promise<void>;  // DELETE /magic_dash — title + company_name required, urlencoded
  deleteById(id: number): Promise<void>;              // DELETE /magic_dash/{id}
  updatePositions(data: { company_id: number; positions: Array<{ id: number; position: number }> }): Promise<{ success: boolean }>;
}
// MagicDashListParams = ListParams & { title?: string; company_id?: number }
```

### MatchersResource

No `get`, no `create`. `integration_id` is a query param (and part of list params), not a
path segment.

```ts
class MatchersResource {
  list(params: MatchersListParams): AsyncIterable<Matcher>;
  listPages(params: MatchersListParams): AsyncIterable<Page<Matcher>>;
  listAll(params: MatchersListParams): Promise<Matcher[]>;
  update(id: number, data: MatcherUpdate): Promise<Matcher>;
  delete(id: number): Promise<void>;
}
// MatchersListParams = ListParams & {
//   integration_id: number; matched?: boolean; sync_id?: number; identifier?: string; company_id?: number
// }
```

### NetworksResource

Non-paginated (`paginated: false`).

```ts
class NetworksResource {
  get(id: number): Promise<Network>;
  list(params?: NetworksListParams): AsyncIterable<Network>;
  listPages(params?: NetworksListParams): AsyncIterable<Page<Network>>;
  listAll(params?: NetworksListParams): Promise<Network[]>;
  create(data: NetworkCreate): Promise<Network>;      // raw
  update(id: number, data: NetworkUpdate): Promise<Network>;
  delete(id: number): Promise<void>;
}
// NetworksListParams = ListParams & {
//   company_id?: number; slug?: string; name?: string; network_type?: number; address?: string;
//   location_id?: number; created_at?: string; updated_at?: string; archived?: boolean
// }
```

### PasswordFoldersResource

```ts
class PasswordFoldersResource {
  get(id: number): Promise<PasswordFolder>;
  list(params?: PasswordFoldersListParams): AsyncIterable<PasswordFolder>;
  listPages(params?: PasswordFoldersListParams): AsyncIterable<Page<PasswordFolder>>;
  listAll(params?: PasswordFoldersListParams): Promise<PasswordFolder[]>;
  create(data: PasswordFolderCreate): Promise<PasswordFolder>;  // wrapped
  update(id: number, data: PasswordFolderUpdate): Promise<PasswordFolder>;
  delete(id: number): Promise<void>;
}
// PasswordFoldersListParams = ListParams & { name: string; company_id: number; search: string }
```

### PhotosResource

`create` is multipart (`file` + required `caption`, plus optional `company_id`,
`photoable_type`, `photoable_id`, `folder_id`, `pinned`); `update` wraps the body in
`{ photo }`; `get` with `download: true` returns a `Blob`.

```ts
class PhotosResource {
  get(id: number, opts?: { download?: boolean }): Promise<Photo | Blob>;
  list(params?: PhotosListParams): AsyncIterable<Photo>;
  listPages(params?: PhotosListParams): AsyncIterable<Page<Photo>>;
  listAll(params?: PhotosListParams): Promise<Photo[]>;
  create(data: PhotoCreate): Promise<Photo>;   // multipart (file + required caption)
  update(id: number, data: PhotoUpdate): Promise<Photo>;
  delete(id: number): Promise<void>;
}
// PhotosListParams = ListParams & {
//   company_id?: number; photoable_type?: string; photoable_id?: number; folder_id?: number;
//   archived?: boolean; created_at?: string; updated_at?: string
// }
```

### ProcedureTasksResource

Non-paginated (`paginated: false`).

```ts
class ProcedureTasksResource {
  get(id: number): Promise<ProcedureTask>;
  list(params?: ProcedureTasksListParams): AsyncIterable<ProcedureTask>;
  listPages(params?: ProcedureTasksListParams): AsyncIterable<Page<ProcedureTask>>;
  listAll(params?: ProcedureTasksListParams): Promise<ProcedureTask[]>;
  create(data: ProcedureTaskCreate): Promise<ProcedureTask>;  // wrapped
  update(id: number, data: ProcedureTaskUpdate): Promise<ProcedureTask>;
  delete(id: number): Promise<void>;
}
// ProcedureTasksListParams = ListParams & { procedure_id: number; name: string; company_id: number }
```

### ProceduresResource

```ts
class ProceduresResource {
  get(id: number): Promise<Procedure>;
  list(params?: ProceduresListParams): AsyncIterable<Procedure>;
  listPages(params?: ProceduresListParams): AsyncIterable<Page<Procedure>>;
  listAll(params?: ProceduresListParams): Promise<Procedure[]>;
  create(data: ProcedureCreate): Promise<Procedure>;  // raw
  update(id: number, data: ProcedureUpdate): Promise<Procedure>;
  delete(id: number): Promise<void>;
  // Special ops (all POST):
  duplicate(id: number, opts: { company_id: number; name?: string; description?: string }): Promise<Procedure>;
  createFromTemplate(id: number, opts?: { company_id?: number; name?: string; description?: string }): Promise<Procedure>;
  kickoff(id: number, opts?: { asset_id?: number; name?: string }): Promise<{ message: string }>;
}
// ProceduresListParams = ListParams & {
//   type?: string; process_scope?: string; parent_process_id?: number; name?: string; company_id?: number;
//   slug?: string; created_at?: string; updated_at?: string; archived?: string; global_template?: string;
//   company_template?: number; parent_procedure_id?: number
// }
```

### PublicPhotosResource

Multipart `create`/`update` (field `photo` + required `record_type`/`record_id` for
create; `record_type`/`record_id` required for update). No `delete`.

```ts
class PublicPhotosResource {
  get(id: number, opts?: { download?: boolean }): Promise<PublicPhoto | Blob>;
  list(params?: PublicPhotosListParams): AsyncIterable<PublicPhoto>;
  listPages(params?: PublicPhotosListParams): AsyncIterable<Page<PublicPhoto>>;
  listAll(params?: PublicPhotosListParams): Promise<PublicPhoto[]>;
  create(data: PublicPhotoCreate): Promise<PublicPhoto>;   // multipart, raw
  update(id: number, data: PublicPhotoUpdate): Promise<PublicPhoto>;
}
// PublicPhotosListParams = ListParams  (no extra filters)
```

### RackStorageItemsResource

Non-paginated (`paginated: false`).

```ts
class RackStorageItemsResource {
  get(id: number): Promise<RackStorageItem>;
  list(params?: RackStorageItemsListParams): AsyncIterable<RackStorageItem>;
  listPages(params?: RackStorageItemsListParams): AsyncIterable<Page<RackStorageItem>>;
  listAll(params?: RackStorageItemsListParams): Promise<RackStorageItem[]>;
  create(data: RackStorageItemCreate): Promise<RackStorageItem>;  // wrapped
  update(id: number, data: RackStorageItemUpdate): Promise<RackStorageItem>;
  delete(id: number): Promise<void>;
}
// RackStorageItemsListParams = ListParams & {
//   rack_storage_role_id?: number; asset_id?: number; start_unit?: number; end_unit?: number;
//   status?: number; side?: string; created_at?: string; updated_at?: string
// }
```

### RackStoragesResource

Non-paginated (`paginated: false`).

```ts
class RackStoragesResource {
  get(id: number): Promise<RackStorage>;
  list(params?: RackStoragesListParams): AsyncIterable<RackStorage>;
  listPages(params?: RackStoragesListParams): AsyncIterable<Page<RackStorage>>;
  listAll(params?: RackStoragesListParams): Promise<RackStorage[]>;
  create(data: RackStorageCreate): Promise<RackStorage>;  // raw
  update(id: number, data: RackStorageUpdate): Promise<RackStorage>;
  delete(id: number): Promise<void>;
}
// RackStoragesListParams = ListParams & {
//   company_id?: number; location_id?: number; height?: number; min_width?: number; max_width?: number;
//   created_at?: string; updated_at?: string
// }
```

### RelationsResource

No `get`, no `update`.

```ts
class RelationsResource {
  list(params?: RelationsListParams): AsyncIterable<Relation>;
  listPages(params?: RelationsListParams): AsyncIterable<Page<Relation>>;
  listAll(params?: RelationsListParams): Promise<Relation[]>;
  create(data: RelationCreate): Promise<Relation>;    // wrapped
  delete(id: number): Promise<void>;
}
// RelationsListParams = ListParams & {
//   fromable_type?: string; fromable_id?: number; toable_type?: string; toable_id?: number;
//   is_inverse?: boolean; description?: string; created_at?: string; updated_at?: string
// }
```

### S3ExportsResource

Initiates an S3 export only (HTTP 200, empty body).

```ts
class S3ExportsResource {
  create(data?: S3ExportCreate): Promise<void>;
}
```

### UploadsResource

`upload` is multipart; `get` with `download: true` returns a `Blob`.

```ts
class UploadsResource {
  list(params?: UploadsListParams): AsyncIterable<Upload>;
  listPages(params?: UploadsListParams): AsyncIterable<Page<Upload>>;
  listAll(params?: UploadsListParams): Promise<Upload[]>;
  upload(file: File | Blob | Buffer, data: { uploadable_id: number; uploadable_type: string }): Promise<Upload>;
  get(id: number, opts?: { download?: boolean }): Promise<Upload | Blob>;
  delete(id: number): Promise<void>;
}
// UploadsListParams = ListParams  (no extra filters)
```

### UsersResource

Read-only.

```ts
class UsersResource {
  get(id: number): Promise<User>;
  list(params?: UsersListParams): AsyncIterable<User>;
  listPages(params?: UsersListParams): AsyncIterable<Page<User>>;
  listAll(params?: UsersListParams): Promise<User[]>;
}
// UsersListParams = ListParams & {
//   first_name?: string; last_name?: string; search?: string; portal_member_company_id?: number;
//   archived?: boolean; email?: string; security_level?: string
// }
```

### VlanZonesResource

Non-paginated (`paginated: false`).

```ts
class VlanZonesResource {
  get(id: number): Promise<VlanZone>;
  list(params?: VlanZonesListParams): AsyncIterable<VlanZone>;
  listPages(params?: VlanZonesListParams): AsyncIterable<Page<VlanZone>>;
  listAll(params?: VlanZonesListParams): Promise<VlanZone[]>;
  create(data: VlanZoneCreate): Promise<VlanZone>;    // raw
  update(id: number, data: VlanZoneUpdate): Promise<VlanZone>;
  delete(id: number): Promise<void>;
}
// VlanZonesListParams = ListParams & { company_id: number; name: string; created_at: string; updated_at: string; archived: boolean }
```

### VlansResource

Non-paginated (`paginated: false`).

```ts
class VlansResource {
  get(id: number): Promise<Vlan>;
  list(params?: VlansListParams): AsyncIterable<Vlan>;
  listPages(params?: VlansListParams): AsyncIterable<Page<Vlan>>;
  listAll(params?: VlansListParams): Promise<Vlan[]>;
  create(data: VlanCreate): Promise<Vlan>;            // raw
  update(id?: number, data: VlanUpdate): Promise<Vlan>;
  delete(id: number): Promise<void>;
}
// VlansListParams = ListParams & {
//   company_id?: number; vlan_zone_id?: number; name?: string; vlan_id?: number; created_at?: string; updated_at?: string; archived?: boolean
// }
```

### WebsitesResource

```ts
class WebsitesResource {
  get(id: number): Promise<Website>;
  list(params?: WebsitesListParams): AsyncIterable<Website>;
  listPages(params?: WebsitesListParams): AsyncIterable<Page<Website>>;
  listAll(params?: WebsitesListParams): Promise<Website[]>;
  create(data: WebsiteCreate): Promise<Website>;      // raw
  update(id: number, data: WebsiteUpdate): Promise<Website>;
  delete(id: number): Promise<void>;
}
// WebsitesListParams = ListParams & { name: string; slug: string; search: string; updated_at: string }
```

> **Gotcha**: `Website.name` IS the URL and must include the protocol, e.g.
> `https://example.com`.

### ApiInfoResource

```ts
class ApiInfoResource {
  get(): Promise<ApiInfo>;   // ApiInfo = { version?: string; date?: string }
}
```

### ActivityLogsResource

```ts
class ActivityLogsResource {
  list(params?: ActivityLogsListParams): AsyncIterable<ActivityLog>;
  listPages(params?: ActivityLogsListParams): AsyncIterable<Page<ActivityLog>>;
  listAll(params?: ActivityLogsListParams): Promise<ActivityLog[]>;
  deleteAll(params: { datetime: string; delete_unassigned_logs?: boolean }): Promise<void>;  // DELETE /activity_logs — deletes ALL logs from a datetime. Caller beware.
}
// ActivityLogsListParams = ListParams & {
//   user_id?: number; user_email?: string; resource_id?: number; resource_type?: string;
//   action_message?: string; start_date?: string
// }
```

### CardsResource

Integrator cards — `lookup` and `jump`.

```ts
class CardsResource {
  lookup(params: { integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<IntegratorCard[]>;
  jump(params: { integration_type: string; integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<string>;
}
```

---

## Exported type list

The default barrel (`node-hudu`) re-exports all resource types, create/update input types,
and shared types. Notable type-only exports include (non-exhaustive):

`Company`, `CompanyCreate`, `CompanyUpdate`, `Asset`, `AssetCreate`, `AssetUpdate`,
`Article`, `ArticleCreate`, `ArticleUpdate`, `AssetLayout`, `AssetLayoutField`,
`AssetPassword`, `AssetPasswordCreate`, `AssetPasswordUpdate`, `Expiration`,
`ExpirationCreate`, `ExpirationUpdate`, `Export`, `ExportCreate`, `ExportUpdate`,
`Flag`, `FlagType`, `Folder`, `Group`, `GroupMember`, `IntegratorCard`, `IpAddress`,
`Label`, `LabelType`, `List`, `ListItem`, `MagicDash`, `Matcher`, `Network`,
`PasswordFolder`, `Photo`, `Procedure`, `ProcedureTask`, `PublicPhoto`, `RackStorage`,
`RackStorageItem`, `Relation`, `S3Export`, `Upload`, `User`, `Vlan`, `VlanZone`,
`Website`, `ApiInfo`, `ActivityLog`, `CompanyIntegration`, `AssetLayoutField`, `Page`,
`ListParams`.

All input types follow the pattern `<Type>Create = Partial<Omit<Base, 'id'|'created_at'|'updated_at'|'url'|'full_url'>>`
and `<Type>Update = Partial<Base>` — every create/update field is optional at the type
level, with the API's actual requirements documented per field in the type comments.
---

## Appendix — capability registry (generated)

Generated from `capabilities.json` (planHash `da4bf1f2de978259`, 225 operations). One row per operation; the same data is importable as
`node-hudu/capabilities` (`getCapability(name)`) and is what the MCP tool manifest is projected from.

| Operation | Kind | Effect | Flags | dryRun | Compact | Bound |
|---|---|---|---|---|---|---|
| `activity_logs.deleteAll` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `activity_logs.findByResource` | helper | read | - | no | ActivityLogSummary | none (not paginated) |
| `activity_logs.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `activity_logs.resolve` | helper | read | - | no | ActivityLogSummary | none (not paginated) |
| `api_info.get` | primitive | read | - | no | - | none (not paginated) |
| `api_info.resolve` | helper | read | - | no | - | none (not paginated) |
| `articles.archive` | primitive | write | idempotent | yes | - | none (not paginated) |
| `articles.create` | primitive | write | - | yes | - | none (not paginated) |
| `articles.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `articles.findBySlug` | helper | read | - | no | ArticleSummary | none (not paginated) |
| `articles.get` | primitive | read | - | no | - | none (not paginated) |
| `articles.getContext` | helper | read | - | no | ArticleContext | none (not paginated) |
| `articles.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `articles.resolve` | helper | read | - | no | ArticleSummary | none (not paginated) |
| `articles.search` | helper | read | - | no | ArticleSummary | none (not paginated) |
| `articles.unarchive` | primitive | write | idempotent | yes | - | none (not paginated) |
| `articles.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `asset_layouts.create` | primitive | write | - | yes | - | none (not paginated) |
| `asset_layouts.get` | primitive | read | - | no | - | none (not paginated) |
| `asset_layouts.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `asset_layouts.resolve` | helper | read | - | no | AssetLayoutSummary | none (not paginated) |
| `asset_layouts.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `asset_passwords.archive` | primitive | write | sensitive, idempotent | yes | - | none (not paginated) |
| `asset_passwords.create` | primitive | write | sensitive | yes | - | none (not paginated) |
| `asset_passwords.delete` | primitive | destructive | sensitive, idempotent, requiresApproval | yes | - | none (not paginated) |
| `asset_passwords.findBySlug` | helper | read | sensitive | no | AssetPasswordSummary | none (not paginated) |
| `asset_passwords.get` | primitive | read | sensitive | no | - | none (not paginated) |
| `asset_passwords.list` | primitive | read | sensitive | no | - | 25 per page, max 100 |
| `asset_passwords.resolve` | helper | read | sensitive | no | AssetPasswordSummary | none (not paginated) |
| `asset_passwords.search` | helper | read | sensitive | no | AssetPasswordSummary | none (not paginated) |
| `asset_passwords.unarchive` | primitive | write | sensitive, idempotent | yes | - | none (not paginated) |
| `asset_passwords.update` | primitive | write | sensitive, idempotent | yes | - | none (not paginated) |
| `assets.archive` | primitive | write | idempotent | yes | - | none (not paginated) |
| `assets.create` | primitive | write | - | yes | - | none (not paginated) |
| `assets.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `assets.findBySerial` | helper | read | - | no | AssetSummary | none (not paginated) |
| `assets.get` | primitive | read | - | no | - | none (not paginated) |
| `assets.getContext` | helper | read | - | no | AssetContext | none (not paginated) |
| `assets.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `assets.listAcrossCompanies` | primitive | read | - | no | - | none (not paginated) |
| `assets.moveLayout` | primitive | write | idempotent | yes | - | none (not paginated) |
| `assets.resolve` | helper | read | - | no | AssetSummary | none (not paginated) |
| `assets.search` | helper | read | - | no | AssetSummary | none (not paginated) |
| `assets.unarchive` | primitive | write | idempotent | yes | - | none (not paginated) |
| `assets.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `cards.jump` | primitive | read | - | no | - | none (not paginated) |
| `cards.lookup` | primitive | read | - | no | - | none (not paginated) |
| `cards.resolve` | helper | read | - | no | IntegratorCardSummary | none (not paginated) |
| `companies.archive` | primitive | write | idempotent | yes | - | none (not paginated) |
| `companies.create` | primitive | write | - | yes | - | none (not paginated) |
| `companies.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `companies.findByDomain` | helper | read | - | no | CompanySummary | none (not paginated) |
| `companies.findBySlug` | helper | read | - | no | CompanySummary | none (not paginated) |
| `companies.get` | primitive | read | - | no | - | none (not paginated) |
| `companies.getContext` | helper | read | - | no | CompanyContext | none (not paginated) |
| `companies.jump` | primitive | read | - | no | - | none (not paginated) |
| `companies.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `companies.resolve` | helper | read | - | no | CompanySummary | none (not paginated) |
| `companies.search` | helper | read | - | no | CompanySummary | none (not paginated) |
| `companies.unarchive` | primitive | write | idempotent | yes | - | none (not paginated) |
| `companies.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `expirations.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `expirations.findByResource` | helper | read | - | no | ExpirationSummary | none (not paginated) |
| `expirations.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `expirations.resolve` | helper | read | - | no | ExpirationSummary | none (not paginated) |
| `expirations.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `exports.create` | primitive | write | - | yes | - | none (not paginated) |
| `exports.get` | primitive | read | - | no | - | none (not paginated) |
| `exports.list` | primitive | read | - | no | - | none (not paginated) |
| `exports.resolve` | helper | read | - | no | - | none (not paginated) |
| `flag_types.create` | primitive | write | - | yes | - | none (not paginated) |
| `flag_types.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `flag_types.get` | primitive | read | - | no | - | none (not paginated) |
| `flag_types.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `flag_types.resolve` | helper | read | - | no | FlagTypeSummary | none (not paginated) |
| `flag_types.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `flags.create` | primitive | write | - | yes | - | none (not paginated) |
| `flags.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `flags.findByFlagable` | helper | read | - | no | FlagSummary | none (not paginated) |
| `flags.get` | primitive | read | - | no | - | none (not paginated) |
| `flags.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `flags.resolve` | helper | read | - | no | FlagSummary | none (not paginated) |
| `flags.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `folders.create` | primitive | write | - | yes | - | none (not paginated) |
| `folders.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `folders.get` | primitive | read | - | no | - | none (not paginated) |
| `folders.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `folders.resolve` | helper | read | - | no | FolderSummary | none (not paginated) |
| `folders.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `groups.get` | primitive | read | - | no | - | none (not paginated) |
| `groups.list` | primitive | read | - | no | - | 25 per page, max 1000 |
| `groups.resolve` | helper | read | - | no | GroupSummary | none (not paginated) |
| `groups.search` | helper | read | - | no | GroupSummary | none (not paginated) |
| `ip_addresses.create` | primitive | write | - | yes | - | none (not paginated) |
| `ip_addresses.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `ip_addresses.findByAddress` | helper | read | - | no | IpAddressSummary | none (not paginated) |
| `ip_addresses.get` | primitive | read | - | no | - | none (not paginated) |
| `ip_addresses.list` | primitive | read | - | no | - | none (not paginated) |
| `ip_addresses.resolve` | helper | read | - | no | IpAddressSummary | none (not paginated) |
| `ip_addresses.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `label_types.create` | primitive | write | - | yes | - | none (not paginated) |
| `label_types.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `label_types.get` | primitive | read | - | no | - | none (not paginated) |
| `label_types.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `label_types.resolve` | helper | read | - | no | LabelTypeSummary | none (not paginated) |
| `label_types.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `labels.create` | primitive | write | - | yes | - | none (not paginated) |
| `labels.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `labels.findByLabelable` | helper | read | - | no | LabelSummary | none (not paginated) |
| `labels.get` | primitive | read | - | no | - | none (not paginated) |
| `labels.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `labels.resolve` | helper | read | - | no | LabelSummary | none (not paginated) |
| `labels.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `lists.create` | primitive | write | - | yes | - | none (not paginated) |
| `lists.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `lists.findByName` | helper | read | - | no | - | none (not paginated) |
| `lists.get` | primitive | read | - | no | - | none (not paginated) |
| `lists.list` | primitive | read | - | no | - | none (not paginated) |
| `lists.resolve` | helper | read | - | no | - | none (not paginated) |
| `lists.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `magic_dash.create` | primitive | write | - | yes | - | none (not paginated) |
| `magic_dash.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `magic_dash.deleteById` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `magic_dash.findByCompany` | helper | read | - | no | MagicDashSummary | none (not paginated) |
| `magic_dash.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `magic_dash.resolve` | helper | read | - | no | MagicDashSummary | none (not paginated) |
| `magic_dash.updatePositions` | primitive | write | idempotent, requiresApproval | yes | - | none (not paginated) |
| `matchers.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `matchers.findBySyncId` | helper | read | - | no | - | none (not paginated) |
| `matchers.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `matchers.resolve` | helper | read | - | no | - | none (not paginated) |
| `matchers.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `networks.create` | primitive | write | - | yes | - | none (not paginated) |
| `networks.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `networks.findByAddress` | helper | read | - | no | NetworkSummary | none (not paginated) |
| `networks.get` | primitive | read | - | no | - | none (not paginated) |
| `networks.list` | primitive | read | - | no | - | none (not paginated) |
| `networks.resolve` | helper | read | - | no | NetworkSummary | none (not paginated) |
| `networks.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `operations.resolveAny` | helper | read | - | no | ResolutionCandidateHit | none (not paginated) |
| `operations.searchAcrossResources` | helper | read | - | no | SearchHit | none (not paginated) |
| `password_folders.create` | primitive | write | sensitive | yes | - | none (not paginated) |
| `password_folders.delete` | primitive | destructive | sensitive, idempotent, requiresApproval | yes | - | none (not paginated) |
| `password_folders.get` | primitive | read | sensitive | no | - | none (not paginated) |
| `password_folders.list` | primitive | read | sensitive | no | - | 25 per page, max 100 |
| `password_folders.resolve` | helper | read | sensitive | no | PasswordFolderSummary | none (not paginated) |
| `password_folders.search` | helper | read | sensitive | no | PasswordFolderSummary | none (not paginated) |
| `password_folders.update` | primitive | write | sensitive, idempotent | yes | - | none (not paginated) |
| `photos.create` | primitive | write | - | yes | - | none (not paginated) |
| `photos.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `photos.findByPhotoable` | helper | read | - | no | PhotoSummary | none (not paginated) |
| `photos.get` | primitive | read | - | no | - | none (not paginated) |
| `photos.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `photos.resolve` | helper | read | - | no | PhotoSummary | none (not paginated) |
| `photos.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `procedure_tasks.create` | primitive | write | - | yes | - | none (not paginated) |
| `procedure_tasks.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `procedure_tasks.get` | primitive | read | - | no | - | none (not paginated) |
| `procedure_tasks.list` | primitive | read | - | no | - | none (not paginated) |
| `procedure_tasks.resolve` | helper | read | - | no | ProcedureTaskSummary | none (not paginated) |
| `procedure_tasks.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `procedures.create` | primitive | write | - | yes | - | none (not paginated) |
| `procedures.createFromTemplate` | primitive | write | - | yes | - | none (not paginated) |
| `procedures.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `procedures.duplicate` | primitive | write | - | yes | - | none (not paginated) |
| `procedures.get` | primitive | read | - | no | - | none (not paginated) |
| `procedures.getWithTasks` | helper | read | - | no | ProcedureWithTasks | none (not paginated) |
| `procedures.kickoff` | primitive | write | - | yes | - | none (not paginated) |
| `procedures.list` | primitive | read | - | no | - | 25 per page, max 1000 |
| `procedures.resolve` | helper | read | - | no | ProcedureSummary | none (not paginated) |
| `procedures.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `public_photos.create` | primitive | write | - | yes | - | none (not paginated) |
| `public_photos.get` | primitive | read | - | no | - | none (not paginated) |
| `public_photos.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `public_photos.resolve` | helper | read | - | no | - | none (not paginated) |
| `public_photos.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `rack_storage_items.create` | primitive | write | - | yes | - | none (not paginated) |
| `rack_storage_items.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `rack_storage_items.get` | primitive | read | - | no | - | none (not paginated) |
| `rack_storage_items.list` | primitive | read | - | no | - | none (not paginated) |
| `rack_storage_items.resolve` | helper | read | - | no | RackStorageItemSummary | none (not paginated) |
| `rack_storage_items.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `rack_storages.create` | primitive | write | - | yes | - | none (not paginated) |
| `rack_storages.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `rack_storages.get` | primitive | read | - | no | - | none (not paginated) |
| `rack_storages.list` | primitive | read | - | no | - | none (not paginated) |
| `rack_storages.resolve` | helper | read | - | no | RackStorageSummary | none (not paginated) |
| `rack_storages.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `relations.create` | primitive | write | - | yes | - | none (not paginated) |
| `relations.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `relations.findByEndpoints` | helper | read | - | no | RelationSummary | none (not paginated) |
| `relations.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `relations.resolve` | helper | read | - | no | RelationSummary | none (not paginated) |
| `s3_exports.create` | primitive | write | - | yes | - | none (not paginated) |
| `uploads.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `uploads.get` | primitive | read | - | no | - | none (not paginated) |
| `uploads.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `uploads.resolve` | helper | read | - | no | UploadSummary | none (not paginated) |
| `uploads.upload` | primitive | write | - | yes | - | none (not paginated) |
| `users.findByEmail` | helper | read | - | no | UserSummary | none (not paginated) |
| `users.get` | primitive | read | - | no | - | none (not paginated) |
| `users.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `users.resolve` | helper | read | - | no | UserSummary | none (not paginated) |
| `users.search` | helper | read | - | no | UserSummary | none (not paginated) |
| `vlan_zones.create` | primitive | write | - | yes | - | none (not paginated) |
| `vlan_zones.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `vlan_zones.get` | primitive | read | - | no | - | none (not paginated) |
| `vlan_zones.list` | primitive | read | - | no | - | none (not paginated) |
| `vlan_zones.resolve` | helper | read | - | no | VlanZoneSummary | none (not paginated) |
| `vlan_zones.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `vlans.create` | primitive | write | - | yes | - | none (not paginated) |
| `vlans.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `vlans.findByVlanId` | helper | read | - | no | VlanSummary | none (not paginated) |
| `vlans.get` | primitive | read | - | no | - | none (not paginated) |
| `vlans.list` | primitive | read | - | no | - | none (not paginated) |
| `vlans.resolve` | helper | read | - | no | VlanSummary | none (not paginated) |
| `vlans.update` | primitive | write | idempotent | yes | - | none (not paginated) |
| `websites.create` | primitive | write | - | yes | - | none (not paginated) |
| `websites.delete` | primitive | destructive | idempotent, requiresApproval | yes | - | none (not paginated) |
| `websites.findBySlug` | helper | read | - | no | WebsiteSummary | none (not paginated) |
| `websites.get` | primitive | read | - | no | - | none (not paginated) |
| `websites.list` | primitive | read | - | no | - | 25 per page, max 100 |
| `websites.resolve` | helper | read | - | no | WebsiteSummary | none (not paginated) |
| `websites.search` | helper | read | - | no | WebsiteSummary | none (not paginated) |
| `websites.update` | primitive | write | idempotent | yes | - | none (not paginated) |

**Helper contract.** `resolve` throws `NOT_FOUND` on an id miss, returns `null` only after a complete
scan, throws `RESOLUTION_TRUNCATED` when a cap stopped the search, and throws `RESOLUTION_AMBIGUOUS` with the
candidate ids when the filter is inexact. Helper scans are bounded by the client's resolution caps
(500 records / 4 pages by default). `limit` defaults to 25 and throws above 100. Compact summaries declare
the fields they drop; `expand: true` returns the full record.

