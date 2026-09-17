# node-hudu — Architecture

> Source of truth for the `node-hudu` TypeScript SDK. Every later stage (implementer,
> reviewer, shipper) must conform to the file/class/method names and signatures in this
> document. Where the upstream Swagger (`api-docs.json`, Swagger 2.0) is ambiguous, the
> decisions recorded here are authoritative.

---

## 1. Overview

`node-hudu` is a **fully-typed**, TypeScript SDK with three runtime dependencies, all confined to the Markdown converter for the
[Hudu IT documentation API](https://hudu.com). It exposes one resource client class per
Hudu resource. Resource methods return **plain typed data** (arrays and resource objects)
— not `this`, not wrappers — so results can be fed directly into zod schemas, MCP tools,
or downstream ETL without friction.

### Primary use case: MCP servers
The SDK is built to be consumed by **Model Context Protocol (MCP) servers**. Consequences:

- Every read method returns concrete, JSON-serialisable typed data (`T[]` / `T`).
- The **`listAll()`** get-everything helper is the MCP-preferred read: one call, a plain
  array, ready for the tool's output schema.
- No lazy/streaming handles leak into the default path (streaming lives behind the
  optional `list()` async iterator).
- No runtime validation library is required. Types are compile-time contracts. The raw
  JSON from Hudu is returned as-is (with response envelopes unwrapped), so it is trivially
  mappable to output schemas.

---

## 2. Library metadata

| Field | Value |
|-------|-------|
| Package name | `node-hudu` |
| Description | "Fully-typed TypeScript SDK for the Hudu IT documentation API. Built for building MCP servers and integrations." |
| License | MIT |
| Engines | `node >= 24.0.0` |
| Module | Dual ESM + CJS via `tsup` (`dist/index.js` ESM, `dist/index.cjs` CJS, `.d.ts`/`.d.cts`) |
| Runtime deps | **none** (native `fetch`) |
| Type runtime | TypeScript strict; no `zod` at runtime (`zod` is **never** a dependency; MCP consumers supply their own zod) |

---

## 3. Module structure

```
src/
  index.ts                 # Public API barrel (default + named exports)
  client.ts                # HuduClient — top-level facade; wires all resources
  config.ts                # HuduConfig, HuduClientOptions, validation, defaults
  http.ts                  # HttpClient — fetch transport, URL/query building, envelope unwrap helpers
  auth.ts                  # auth strategies + x-api-key header construction / injection
  errors.ts                # HuduError hierarchy + errorFromStatus factory
  pagination.ts            # Page<T>, paginate(), paginateItems(), collectAll(), toArray()
  logger.ts                # Logger interface + NoopLogger
  utils.ts                 # assertRecord, deep-merge of query params, string helpers
  resources/
    index.ts               # Barrel for all resource classes + resources() accessor
    base.ts                # BaseResource<T> — shared CRUD scaffolding
    companies.ts           # CompaniesResource
    articles.ts            # ArticlesResource
    asset_layouts.ts       # AssetLayoutsResource
    asset_passwords.ts     # AssetPasswordsResource
    assets.ts              # AssetsResource (company-scoped) + top-level /assets
    expirations.ts         # ExpirationsResource
    exports.ts             # ExportsResource
    flag_types.ts          # FlagTypesResource
    flags.ts               # FlagsResource
    folders.ts             # FoldersResource
    groups.ts              # GroupsResource
    ip_addresses.ts        # IpAddressesResource
    label_types.ts         # LabelTypesResource
    labels.ts              # LabelsResource
    lists.ts               # ListsResource
    magic_dash.ts          # MagicDashResource
    matchers.ts            # MatchersResource
    networks.ts            # NetworksResource
    password_folders.ts    # PasswordFoldersResource
    photos.ts              # PhotosResource
    procedure_tasks.ts     # ProcedureTasksResource
    procedures.ts          # ProceduresResource
    public_photos.ts       # PublicPhotosResource
    rack_storage_items.ts  # RackStorageItemsResource
    rack_storages.ts       # RackStoragesResource
    relations.ts           # RelationsResource
    s3_exports.ts          # S3ExportsResource
    uploads.ts             # UploadsResource
    users.ts               # UsersResource
    vlan_zones.ts          # VlanZonesResource
    vlans.ts               # VlansResource
    websites.ts            # WebsitesResource
    api_info.ts            # ApiInfoResource
    activity_logs.ts       # ActivityLogsResource
    cards.ts               # CardsResource (integrator cards lookup/jump)
  types/
    index.ts               # Barrel for all types
    common.ts              # Shared types (Page, ListParams, envelope keys, ...)
    company.ts             # Company + CompanyCreate + CompanyUpdate
    article.ts
    asset_layout.ts
    asset_password.ts
    asset.ts
    expiration.ts
    export.ts
    flag_type.ts
    flag.ts
    folder.ts
    group.ts
    ip_address.ts
    label_type.ts
    label.ts
    list.ts
    magic_dash.ts
    matcher.ts
    network.ts
    password_folder.ts
    photo.ts
    procedure_task.ts
    procedure.ts
    public_photo.ts
    rack_storage.ts
    rack_storage_item.ts
    relation.ts
    upload.ts
    user.ts
    vlan.ts
    vlan_zone.ts
    website.ts
    api_info.ts
    activity_log.ts
    integrator_card.ts

test/
  __fixtures__/            # Mock JSON responses per resource (from api-docs.json)
  client.test.ts           # HuduClient construction + wiring
  http.test.ts             # transport, envelopes, error mapping, retries
  pagination.test.ts       # paginate / paginateItems / collectAll
  config.test.ts           # baseUrl/apiKey|auth/rateLimit validation
  auth.test.ts             # auth strategies, header shape, scope isolation
  errors.test.ts           # error hierarchy
  resources/
    companies.test.ts
    articles.test.ts
    assets.test.ts
    procedures.test.ts     # special ops: duplicate / create_from_template / kickoff
    uploads.test.ts        # multipart
    ... (one spec-per-resource file is added alongside each resource)
```

> **File layout rule**: exactly **one resource class per `resources/<name>.ts`** file and
> **one resource-type module per `types/<name>.ts`** file. Nothing else lives in those
> files. This keeps the mapping between types, resources, and test files 1:1.
>
> Two companion modules sit in `resources/` without being resource classes, and are named so
> that they cannot be mistaken for one: `agent-layer-helpers.ts` (shared scan guards) and
> `article-html.ts` (pure Hudu article-HTML rules — `validateArticleHtml`,
> `normalizeArticleHtml`, `diffArticleRoundTrip`; no HTTP, no client, no resource class).

---

## 4. Naming conventions

| Concern | Convention | Examples |
|---------|-----------|----------|
| Resource types | PascalCase interface, **no `I` prefix** | `Company`, `Asset`, `AssetLayout`, `MagicDash` |
| Create/update input types | `<Type>Create`, `<Type>Update` | `CompanyCreate`, `AssetUpdate` |
| Resource client classes | PascalCase + `Resource` suffix | `CompaniesResource`, `AssetPasswordsResource` |
| Resource instance fields | `camelCase`, plural, on `HuduClient` | `client.companies`, `client.assets` |
| Files | `snake_case.ts` | `asset_password.ts`, `company.ts` |
| Methods | `camelCase` verbs | `get`, `list`, `listAll`, `create`, `update`, `delete` |
| Query params interfaces | `<Resource>ListParams` | `CompaniesListParams`, `ArticlesListParams` |

### Standard method names (every CRUD-capable resource)
| Method | Signature (base shape) | Returns | Notes |
|--------|------------------------|---------|-------|
| `get` | `get(id: number, params?: Record<string, unknown>): Promise<T>` | `T` | Single record, envelope-unwrapped. Throws `NotFoundError` on 404. |
| `list` | `list(params?: ListParams & TListParams): AsyncIterable<T>` | async iterator of items | Streams **items** across pages. See §7. |
| `listPages` | `listPages(params?): AsyncIterable<Page<T>>` | async iterator of pages | Streams page objects (lower-level). |
| `listAll` | `listAll(params?): Promise<T[]>` | `T[]` | **Get everything.** MCP-preferred. See §7. |
| `create` | `create(data: TCreate): Promise<T>` | `T` | Envelope-normalised. |
| `update` | `update(id: number, data: TUpdate): Promise<T>` | `T` | Envelope-normalised. |
| `delete` | `delete(id: number): Promise<void>` | `void` | 204/empty success → resolves `undefined`. |
| `archive` | `archive(id: number): Promise<void>` | `void` | `PUT /{resource}/{id}/archive`. Side-effect action. |
| `unarchive` | `unarchive(id: number): Promise<void>` | `void` | `PUT /{resource}/{id}/unarchive`. Side-effect action. |

> **`archive`/`unarchive` return `void`** (not the resource) because the upstream response
> bodies are **inconsistent**: some endpoints return `{ singular: {...} }` (e.g. articles,
> companies) while others return an empty body (e.g. assets). Treating archiving as a
> side-effect action keeps the return type honest and uniform. Consumers that need the
> post-archive state should follow up with `get(id)`.

---

## 5. Public API surface

```ts
// Primary import
import { HuduClient } from 'node-hudu';

const hudu = new HuduClient({
  baseUrl: 'https://hudu.example.com',   // origin only — no path, no trailing slash
  apiKey: process.env.HUDU_API_KEY!,
  // OR an auth strategy — exactly one of apiKey / auth:
  // auth: new BearerTokenAuth(token),
  // optional:
  // timeoutMs: 30_000,
  // maxRetries: 3,
  // logger: console,
  // basePath: '/api/v1',        // override only if your install customises it
});

const companies = await hudu.companies.listAll({ search: 'acme' }); // Company[]
const single   = await hudu.companies.get(companies[0]!.id);        // Company
const created  = await hudu.companies.create({ name: 'Acme Corp' });
await hudu.companies.delete(created.id);

// Type-only imports
import type { Company, Asset, Page } from 'node-hudu';
import type { CompaniesListParams } from 'node-hudu';

// Errors
import { HuduError, NotFoundError, RateLimitError } from 'node-hudu';

// Auth strategies (issue #23): the built-ins, or any object with { name, headers(ctx) }
import { ApiKeyAuth, BearerTokenAuth, HeaderAuth } from 'node-hudu';

// A per-request credential for the same transport state (advanced): a real HuduClient whose only
// difference is its credential. A bare string means an API key, never a bearer token.
const scoped = hudu.withAuth(new ApiKeyAuth(endUserKey));

// Standalone resource construction (advanced)
import { CompaniesResource, HttpClient } from 'node-hudu';
const client   = new HttpClient({ ...config });
const companies = new CompaniesResource(client);
```

### Recommended package export map (add to `package.json` `exports`)
The default barrel at `"."` is sufficient for most consumers. To enable deep imports
(and make tsup emit multiple entries), add:

```jsonc
"exports": {
  ".": { "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
         "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" } },
  "./resources": { "import": { "types": "./dist/resources/index.d.ts", "default": "./dist/resources/index.js" },
                   "require": { "types": "./dist/resources/index.d.cts", "default": "./dist/resources/index.cjs" } },
  "./types":     { "import": { "types": "./dist/types/index.d.ts",     "default": "./dist/types/index.js" },
                   "require": { "types": "./dist/types/index.d.cts",     "default": "./dist/types/index.cjs" } },
  "./errors":    { "import": { "types": "./dist/errors.d.ts",          "default": "./dist/errors.js" },
                   "require": { "types": "./dist/errors.d.cts",          "default": "./dist/errors.cjs" } },
  "./package.json": "./package.json"
}
```

To support this, change tsup `entry` to
`['src/index.ts', 'src/resources/index.ts', 'src/types/index.ts', 'src/errors.ts']`
(the exporter stage should verify the emitted file layout). Deep imports are *optional* —
the primary barrel always re-exports everything.

---

## 6. Config, validation, and defaults

### `config.ts`
```ts
export interface HuduConfig {
  /** Origin only, e.g. 'https://hudu.example.com'. No path, no trailing slash. */
  baseUrl: string;
  /** Hudu API key (scoped via Hudu Admin → Basic Information → API Keys). Required unless `auth`. */
  apiKey?: string;
  /** Pluggable credential source (issue #23): `ApiKeyAuth`, `BearerTokenAuth`, `HeaderAuth`, or own. */
  auth?: AuthStrategy;
  /** defaults to '/api/v1' — the swagger basePath. */
  basePath?: string;
  /** HTTP timeout in ms. default 30_000. */
  timeoutMs?: number;
  /**
   * Retry budget for idempotent requests on 429/5xx. default 3 (0 disables).
   * Non-idempotent methods (POST that are NOT explicit retry-safe) are never retried.
   */
  maxRetries?: number;
  /** Optional request log sink. default: no-op. */
  logger?: Logger;
  /** Optional client-side rate limiter (token bucket). Off by default. */
  rateLimit?: RateLimitConfig;
}
export interface RateLimitConfig {
  /** Max requests per minute. Default 300 (Hudu's documented limit). Must be > 0. */
  perMinute?: number;
  /** Optional max burst beyond steady rate. default perMinute. */
  burst?: number;
}
```

### Validation rules (run in the `HuduClient` constructor)
1. `baseUrl` must parse as an `http:`/`https:` URL; trailing `/` is stripped. Throwing a
   `HuduConfigError` (subclass of `HuduError`) on failure.
2. Exactly ONE of `apiKey` / `auth` must be supplied. `apiKey`, when given, must be a non-empty
   string (whitespace trimmed); a blank key counts as absent, so a blank key plus an `auth` strategy
   is accepted while a blank key alone is refused. Supplying both, neither, a non-string `apiKey`,
   or an `auth` that is not an `AuthStrategy` throws `HuduConfigError` (`CONFIG_ERROR`) before any
   request. A built-in strategy constructor refuses a blank credential.
   `resolveConfig` always returns a strategy: `new ApiKeyAuth(apiKey)` for a key client, the caller's
   strategy otherwise (`ResolvedConfig.apiKey` is then `''`).
3. `basePath` must start with `/`; defaults to `/api/v1`.
4. `timeoutMs` must be a positive integer (0 is rejected); `maxRetries` must be a non-negative integer.
5. `rateLimit.perMinute` must be a positive integer (default 300). If the API returns 429
   and `maxRetries > 0`, the client honours `Retry-After` / `X-RateLimit-Reset` headers and
   backs off, regardless of the optional client-side limiter.

> The server enforces the 300 req/min limit itself. The client-side limiter is **opt-in**
> and intended for bursty MCP servers; it is a simple token-bucket in `http.ts` and adds no
> runtime dependency.

---

## 7. Pagination strategy

Hudu paginates list responses with `?page=X` and `?page_size=Y` (default 25/page).
**Not every list endpoint paginates.** The following list endpoints in `api-docs.json` do
**not** declare `page`/`page_size` and return all results in one call:

`/ip_addresses`, `/lists`, `/networks`, `/procedure_tasks`, `/rack_storage_items`,
`/rack_storages`, `/vlan_zones`, `/vlans` (+ `/exports`, `/api_info` and the jump/lookup
endpoints, which are handled separately).

Every resource carries a `paginated` capability flag (`BaseResource.paginated`) so the
pagination machinery knows whether to walk pages or return the single list.

### `pagination.ts`
```ts
export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  hasMore: boolean;
}

/** Parameters understood by every list method. */
export interface ListParams {
  page?: number;
  page_size?: number;
  [key: string]: unknown; // additional resource-specific filters (typed per resource)
}

type PageFetcher<T> = (page: number, pageSize: number) => Promise<Page<T>>;

export async function* paginate<T>(fetchPage: PageFetcher<T>): AsyncGenerator<Page<T>>;
export async function* paginateItems<T>(fetchPage: PageFetcher<T>): AsyncGenerator<T>;
export async function collectAll<T>(fetchPage: PageFetcher<T>): Promise<T[]>;
export async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]>;
```

### How the three read methods behave per resource

| Resource capability | `list()` | `listPages()` | `listAll()` |
|---------------------|----------|---------------|-------------|
| `paginated: true` | async-iter items across pages | async-iter pages | collect all pages → `T[]` |
| `paginated: false` | single list, yielded | single-page iterator | the whole list → `T[]` |

- `listAll` is the **recommended MCP read**: deterministic, returns a plain `T[]`.
- `list` is for streaming large result sets without buffering (`for await ...`).
- Iterators auto-stop when a page returns fewer than `page_size` items **or** `hasMore`
  is false. Default `page_size` = 25; consumers should raise it (e.g. 100) inside filters
  when expecting many records.
- Filtering is a **server-side** concern (query params). The SDK never does client-side
  post-filtering.

**Typical page fetcher** (used internally by `BaseResource`):
```ts
private async fetchPage<T>(page: number, pageSize: number): Promise<Page<T>> {
  const body = await this.http.request<Record<string, unknown>>({
    method: 'GET',
    path: `/${this.resourcePath}`,
    query: { ...this.pageParams, page, page_size: pageSize },
  });
  const items = this.unwrapList<T>(body) as T[];
  const hasMore = items.length === pageSize; // Hudu returns fewer than page_size on the last page
  return { items, page, page_size: pageSize, hasMore };
}
```

---

## 8. HTTP transport (`http.ts`)

- Uses the **native global `fetch`** (Node ≥ 18). **Three runtime dependencies, confined to one module.** `src/content/` uses `turndown`, `@joplin/turndown-plugin-gfm` and `marked`. Nothing outside `src/content/` imports them, and no type of theirs appears in an exported signature. Every other subsystem — HTTP, auth, pagination, search, MCP — still uses native platform APIs alone.
- `HttpClient.request<T>(opts): Promise<T>` is the single transport primitive.

```ts
export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path after basePath, e.g. '/companies/{id}' (already interpolated) or
      '/companies/{companyId}/assets/{id}'. */
  path: string;
  query?: Record<string, unknown>;   // turned into a URLSearchParams
  body?: unknown;                    // JSON-encoded unless formData is present
  formData?: FormData;               // for multipart uploads (uploads resource)
  headers?: Record<string, string>;  // extra headers
}
```

### Behaviour
1. **URL**: `${baseUrl}${basePath}${path}` with `query` appended via `URLSearchParams`.
   `null`/`undefined`/empty-string query values are omitted (clean request sanitisation).
2. **Auth**: the resolved `AuthStrategy` produces the credential headers — `ApiKeyAuth` (the
   default) injects `{ 'x-api-key': apiKey }`, `BearerTokenAuth` injects `Authorization: Bearer`, and
   `HeaderAuth` injects a fixed map. Precedence: strategy headers < caller `headers` < `Accept` <
   `Content-Type`. `headers(ctx)` is resolved once per ATTEMPT, inside the retry loop, so a retry
   after backoff can pick up a rotated credential; a dry run resolves nothing.
3. **Timeout**: a whole-call deadline of `timeoutMs` bounds the ENTIRE request (connection,
   all retry attempts, backoff, and the rate-limit token wait). It is not a per-attempt
   timeout — callers configure the total budget for the call, so a slow-but-OK server or a
   long rate-limit hold can consume the budget before later retries.
4. **Content-type**: `application/json` when `body` is set; `multipart/form-data`
   boundary via `FormData` when `formData` is set.
5. **Response handling**:
   - `2xx` → parse JSON (if body present). `204`/empty body → resolve `undefined`.
   - non-2xx → throw via `errorFromStatus(status, body, url)`.
   - network/AbortError → `HuduNetworkError` (subclass of `HuduError`).
6. **Retries**: on `429`/`5xx`, retry up to `maxRetries` with exponential backoff +
   `Retry-After` respect. Only **idempotent** methods (`GET`, `PUT`, `DELETE`) are retried;
   `POST` is not (except explicit retry-safe POSTs such as `archive`? **no** — safest is:
   only `GET` and `PUT`/`DELETE` that the caller flagged; default: GET/PUT/DELETE retried,
   POST not).
7. **Response envelope**: `request<T>` returns the **raw parsed body** (`Record<string, unknown>`
   for JSON objects). **It does not auto-unwrap.** Envelope unwrapping is an explicit,
   per-call decision made by the resource layer using the helpers below. This avoids
   mis-parsing the intentionally-inconsistent upstream shapes.

### Envelope unwrapping helpers (in `http.ts`, used by `BaseResource`)
```ts
/** If data is an object with `key`, returns data[key]; otherwise returns data.
    Used for single-resource responses: { company: {...} } -> {...}. */
export function unwrapByKey<T>(data: unknown, key?: string): T;

/** For list responses: expects data[key] to be an array; returns that array.
    If `key` is absent, passes the body through as T[]. */
export function unwrapList<T>(data: unknown, key?: string): T[];
export function isRecord(v: unknown): v is Record<string, unknown>;
```

### Envelope convention (verified against `api-docs.json`)
- **List** → `{ "<plural_resource>": [...] }`, e.g. `GET /companies` → `{ companies: [...] }`,
  `GET /articles` → `{ articles: [...] }`, `GET /asset_passwords` →
  `{ asset_passwords: [...] }`.
- **Single (GET/PUT)** → `{ "<singular_resource>": {...} }`, e.g. `GET /companies/{id}` →
  `{ company: {...} }`, `GET /articles/{id}` → `{ article: {...} }`.
- **Create** → **inconsistent**: some endpoints return raw definition
  (`POST /articles` → the `Article` object directly; `POST /companies` → raw `Company`;
  `POST /lists`, `/magic_dash`, `/networks`, `/procedures`, `/uploads`, `/public_photos`,
  `/rack_storages`, `/vlan_zones`, `/vlans`, `/ip_addresses`,
  `/companies/{company_id}/assets` all return the raw resource), while others return a
  wrapped singular (`POST /asset_layouts` → `{ asset_layout }`, `/asset_passwords`,
  `/flag_types`, `/flags`, `/folders`, `/label_types`, `/labels`, `/password_folders`,
  `/photos`, `/procedure_tasks`, `/relations`).
- Some endpoints return **empty** success bodies (`POST /exports` → 200 null,
  `POST /s3_exports` → 200 null, `DELETE *` → 204).

**Resolution**: each resource declares its envelope keys (`singleKey`, `listKey`) and a
`createReturns`: `'raw' | 'wrapped'` flag. `BaseResource` uses these to normalise:

```ts
// create/update
const body = await this.http.request<unknown>({ ... });
if (this.createReturns === 'wrapped') return unwrapByKey<T>(body, this.singleKey);
return body as T;
```

| Endpoint pattern | Envelope | SDK normalises to |
|------------------|----------|-------------------|
| `GET /{resource}` | `{ plural: T[] }` | `T[]` |
| `GET /{resource}/{id}` | `{ singular: T }` | `T` |
| `POST /{resource}` (raw style) | `T` (raw) | `T` |
| `POST /{resource}` (wrapped style) | `{ singular: T }` | `T` |
| `PUT /{resource}/{id}` | `{ singular: T }` | `T` |
| `PUT archive/unarchive` | mixed (see §4) | `void` |
| `DELETE ` | `204` / empty | `void` |

The **per-resource envelope table is generated from `api-docs.json`** and must be verified
by the code reviewer against the spec for every resource (listKey, singleKey,
createReturns, paginated).

---

## 9. Auth (`auth.ts`)

```ts
export const API_KEY_HEADER = 'x-api-key';
export function buildAuthHeaders(apiKey: string): Record<string, string>;
export function withAuth(headers: Record<string,string> | undefined, apiKey: string): Record<string,string>;

export type AuthHeaders = Record<string, string>;
export interface AuthContext {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;      // after basePath, e.g. '/companies/42'
  readonly url: string;       // absolute, query string stripped
  readonly correlationId: string;
  readonly attempt: number;
}
export interface AuthStrategy {
  readonly name: string;
  headers(ctx: AuthContext): AuthHeaders | Promise<AuthHeaders>;
  readonly secretHeaders?: readonly string[];
}
export class ApiKeyAuth implements AuthStrategy { constructor(apiKey: string); }
export class BearerTokenAuth implements AuthStrategy { constructor(token: string); }
export class HeaderAuth implements AuthStrategy {
  constructor(headers: Record<string, string>, options?: { name?: string; secretHeaders?: readonly string[] });
}
```

- The default mechanism is the `x-api-key` header (`securityDefinitions.APIKeyHeader`). A pluggable
  `AuthStrategy` may produce any header set instead: `ApiKeyAuth` (default), `BearerTokenAuth`
  (a Hudu-fronting proxy), `HeaderAuth`, or a caller's own `{ name, headers(ctx) }`.
- `resolveConfig` accepts EXACTLY ONE of `apiKey` / `auth` and fails closed (`CONFIG_ERROR`)
  otherwise; `ResolvedConfig.auth` is always present and is the only field the transport reads.
- `headers(ctx)` is called at most once per ATTEMPT, never for a dry run, and never at construction.
  The whole-call `timeoutMs` bounds it: a resolver that misses the budget fails with `AUTH_ERROR`
  and no request is sent.
- `client.withAuth(strategyOrToken)` returns a real `HuduClient` that shares the parent's
  `TransportState` (one token bucket), logger and audit hook, and differs only in its credential.
  A bare string is an API key.
- Never log or echo the key or token; the logger redacts credential-shaped names, and a strategy's
  `secretHeaders` extend that set for audit events.

---

## 10. Error hierarchy (`errors.ts`)

```
HuduError (base; extends Error)
  status?: number
  code: string                       // machine-readable, e.g. 'BAD_REQUEST'
  url?: string
  body?: unknown                     // raw response body when available
  |
  ├── HuduConfigError                // invalid client config (covers validation)
  ├── HuduNetworkError               // fetch/Abort failure (transport-level)
  ├── BadRequestError        (400)
  ├── UnauthorizedError      (401)
  ├── ForbiddenError         (403)
  ├── NotFoundError          (404)
  ├── MethodNotAllowedError  (405)
  ├── NotAcceptableError     (406)   // e.g. /companies/jump with Accept: application/json
  ├── UnprocessableEntityError (422)
  ├── RateLimitError         (429)   // carries retryAfter?: number (seconds) if header present
  └── ServerError            (5xx)
```

```ts
export function errorFromStatus(status: number, body: unknown, url?: string): HuduError;
export function isHuduError(err: unknown): err is HuduError;
```

- Factory maps HTTP status → subclass; unknown/5xx → `ServerError`.
- `HuduError.name` is set to the class name (helps MCP error handling introspect).

---

## 11. Base resource (`resources/base.ts`)

```ts
export abstract class BaseResource<T> {
  protected readonly http: HttpClient;

  /** Plural URL path under basePath, e.g. 'companies', 'asset_passwords'. */
  protected readonly resourcePath: string;
  /** Envelope key for single responses, e.g. 'company'. */
  protected readonly singleKey?: string;
  /** Envelope key for list responses, e.g. 'companies'. */
  protected readonly listKey?: string;
  /** 'raw' | 'wrapped' — how create/update responses arrive. */
  protected readonly createType: 'raw' | 'wrapped';
  /** Whether the list endpoint supports page/page_size. */
  protected readonly paginated: boolean;

  constructor(http: HttpClient);

  // ---- core read primitives (wired to pagination helpers) ----
  protected fetchPage(params: ListParams, page: number, pageSize: number): Promise<Page<T>>;
  /** Build the render of an async-iter of items. Subclasses expose typed `list`. */
  protected items(params: ListParams): AsyncIterable<T>;
  /** Collect everything (used by listAll). */
  protected all(params: ListParams): Promise<T[]>;

  // ---- envelope helpers (see §8) ----
  protected unwrapSingle<U = T>(data: unknown): U;
  protected unwrapList<U = T>(data: unknown): U[];
  protected async request<U>(opts: RequestOptions): Promise<U>;
}
```

Concrete resources extend `BaseResource<T>` and expose **narrowly-typed** public methods.
`BaseResource` stays generic and untyped about filters; each subclass defines its own
`<Resource>ListParams` interface.

---

## 12. Resource client reference

Conventions used below: `T` = resource type, `TCreate`/`TUpdate` = input types,
`LP` = `<Resource>ListParams`. Params with a `?` are optional. `companyId` prefix means the
method is company- or parent-scoped. Ellipses `…c` means "plus the standard list filters
typed for that resource".

### 12.1 `CompaniesResource` — path `companies`
```ts
const r: CompaniesResource = hudu.companies;
r.get(id: number): Promise<Company>
r.list(params?: CompaniesListParams): AsyncIterable<Company>
r.listPages(params?: CompaniesListParams): AsyncIterable<Page<Company>>
r.listAll(params?: CompaniesListParams): Promise<Company[]>
r.create(data: CompanyCreate): Promise<Company>            // createType 'raw'
r.update(id: number, data: CompanyUpdate): Promise<Company>
r.delete(id: number): Promise<void>                        // 204
r.archive(id: number): Promise<void>
r.unarchive(id: number): Promise<void>
r.jump(params: { integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<string>
```
- `CompaniesListParams` = `ListParams & { name?; phone_number?; website?; city?; id_number?; state?; slug?; search?; id_in_integration?; updated_at? }`.
- `jump()` hits `GET /companies/jump` which returns a **302 redirect**; follow redirects in
  fetch (default) and return the final location URL. (The 406 case surfaces when
  `Accept: application/json` — we override `Accept` to `text/html` for this call.)

### 12.2 `ArticlesResource` — path `articles`
```ts
r.get(id): Promise<Article>
r.list(params?: ArticlesListParams): AsyncIterable<Article>
r.listAll(params?): Promise<Article[]>
r.create(data: ArticleCreate): Promise<Article>            // createType 'raw'
r.update(id, data: ArticleUpdate): Promise<Article>
r.delete(id): Promise<void>
r.archive(id): Promise<void>
r.unarchive(id): Promise<void>
```
`ArticlesListParams` incl. `name?`, `company_id?`, `draft?`, `enable_sharing?`, `slug?`, `search?`, `updated_at?`.

### 12.3 `AssetLayoutsResource` — path `asset_layouts`
`get`, `list`, `listAll`, `create` (createType **'wrapped'**), `update`, plus `Archive`
none/`delete`? — spec has **no** DELETE for asset layouts (only GET/POST/PUT). Provide
`get/list/listPages/listAll/create/update`.

### 12.4 `AssetPasswordsResource` — path `asset_passwords`
`get`, `list`, `listAll`, `create` (**'wrapped'**), `update`, `delete`, `archive`, `unarchive`.

### 12.5 `AssetsResource` — company-scoped, base path `companies/{companyId}/assets`
```ts
const a: AssetsResource = hudu.assets;
a.get(companyId: number, id: number): Promise<Asset>
a.list(companyId: number, params?: CompanyAssetsListParams): AsyncIterable<Asset>
a.listAll(companyId: number, params?): Promise<Asset[]>
a.create(companyId: number, data: AssetCreate): Promise<Asset>   // createType 'raw'
a.update(companyId: number, id: number, data: AssetUpdate): Promise<Asset>
a.delete(companyId: number, id: number): Promise<void>
a.archive(companyId: number, id: number): Promise<void>
a.unarchive(companyId: number, id: number): Promise<void>
a.moveLayout(companyId: number, id: number, data: { asset_layout_id: number }): Promise<Asset>
// top-level (account-wide) list via GET /assets
a.listAllAcrossCompanies(params?: AccountAssetsListParams): Promise<Asset[]>
```
`CompanyAssetsListParams` incl. `archived?`, `page?`, `page_size?`.
`AccountAssetsListParams` incl. `company_id?`, `id?`, `name?`, `primary_serial?`, `asset_layout_id?`, `archived?`, `page?`, `page_size?`.

### 12.6 `ExpirationsResource` — path `expirations`
`list`, `listPages`, `listAll`, `update(id, data)`, `delete(id)`. (No single GET, no create.)

### 12.7 `ExportsResource` — path `exports`
```ts
r.list(params?): AsyncIterable<Export>
r.listAll(params?): Promise<Export[]>
r.create(data: ExportCreate): Promise<void>     // POST /exports returns 200 (null body)
r.get(id: number, opts?: { download?: boolean }): Promise<Export | Blob>
```
`get({download:true})` requests the binary; when not downloading returns metadata.

### 12.8 `FlagTypesResource` — path `flag_types`
`get`, `list`, `listAll`, `create` (**'wrapped'**), `update`, `delete`.

### 12.9 `FlagsResource` — path `flags`
`get`, `list`, `listAll`, `create` (**'wrapped'**), `update`, `delete`.

### 12.10 `FoldersResource` — path `folders`
`get`, `list`, `listAll`, `create` (**'wrapped'**), `update`, `delete`.

### 12.11 `GroupsResource` — path `groups` (read-only)
`get(id): Promise<Group>`, `list(params?): AsyncIterable<Group>`, `listAll(params?): Promise<Group[]>`.

### 12.12 `IpAddressesResource` — path `ip_addresses` (not paginated)
`get`, `list`, `listAll` (single call), `create` (**'raw'**), `update`, `delete`.

### 12.13 `LabelTypesResource` — path `label_types`
`get`, `list`, `listAll`, `create` (**'wrapped'**), `update`, `delete`.

### 12.14 `LabelsResource` — path `labels`
`get`, `list`, `listAll`, `create` (**'wrapped'**), `update`, `delete`.

### 12.15 `ListsResource` — path `lists` (not paginated)
`get`, `list`, `listAll`, `create` (**'raw'**), `update`, `delete`.
`ListsListParams` incl. `query?`, `name?`.

### 12.16 `MagicDashResource` — path `magic_dash`
```ts
r.list(params?: MagicDashListParams): AsyncIterable<MagicDash>   // query: title?, company_id?
r.listAll(params?): Promise<MagicDash[]>
r.create(data: MagicDashCreate): Promise<MagicDash>              // createType 'raw'; POST may create or update
r.delete(data: { title: string; company_name: string }): Promise<void>   // DELETE /magic_dash — title + company_name required, urlencoded
r.deleteById(id: number): Promise<void>          // DELETE /magic_dash/{id}
r.updatePositions(data: { company_id: number; positions: Array<{ id: number; position: number }> }): Promise<{ success: boolean }>
```

### 12.17 `MatchersResource` — path `matchers` (**`integration_id` is a query param, not a path segment**)
```ts
r.list(params: MatchersListParams): AsyncIterable<Matcher>   // integration_id (required), matched?, sync_id?, identifier?, company_id?
r.listPages(params: MatchersListParams): AsyncIterable<Page<Matcher>>
r.listAll(params: MatchersListParams): Promise<Matcher[]>
r.update(id: number, data: MatcherUpdate): Promise<Matcher>
r.delete(id: number): Promise<void>
```
(No single `get`, no `create`.)

### 12.18 `NetworksResource` — path `networks` (not paginated)
`get`, `list`, `listAll`, `create` (**'raw'**), `update`, `delete`.

### 12.19 `PasswordFoldersResource` — path `password_folders`
`get`, `list`, `listAll`, `create` (**'wrapped'**), `update`, `delete`.

### 12.20 `PhotosResource` — path `photos`
`get`, `list`, `listAll`, `create` (**'wrapped'**, multipart: `file` + `caption` (required) + `company_id`? + `photoable_type`? + `photoable_id`? + `folder_id`? + `pinned`?), `update`, `delete`. `get(id, { download?: boolean })`.

### 12.21 `ProcedureTasksResource` — path `procedure_tasks` (not paginated)
`get`, `list` (query: `procedure_id?`, `name?`, `company_id?`), `listAll`, `create` (**'wrapped'**), `update`, `delete`.

### 12.22 `ProceduresResource` — path `procedures` (+ special ops)
```ts
r.get(id): Promise<Procedure>
r.list(params?: ProceduresListParams): AsyncIterable<Procedure>
r.listAll(params?): Promise<Procedure[]>
r.create(data: ProcedureCreate): Promise<Procedure>   // createType 'raw'
r.update(id, data: ProcedureUpdate): Promise<Procedure>
r.delete(id): Promise<void>
r.duplicate(id: number, opts: { company_id: number; name?: string; description?: string }): Promise<Procedure>  // POST /procedures/{id}/duplicate
r.createFromTemplate(id: number, opts?: { company_id?: number; name?: string; description?: string }): Promise<Procedure> // POST /procedures/{id}/create_from_template
r.kickoff(id: number, opts?: { asset_id?: number; name?: string }): Promise<{ message: string }> // POST /procedures/{id}/kickoff
```
`ProceduresListParams` incl. `type?`, `process_scope?`, `parent_process_id?`, `name?`, `company_id?`, `slug?`, `archived?`, `global_template?`, `company_template?`, `parent_procedure_id?`.

### 12.23 `PublicPhotosResource` — path `public_photos`
`get`, `list`, `listAll`, `create` (**'raw'**; multipart field `photo` + required `record_type`/`record_id`), `update` (multipart, required `record_type`/`record_id`). No DELETE in spec. GET/PUT are `{public_photo}`-wrapped; `update` unwraps the envelope.

### 12.24 `RackStorageItemsResource` — path `rack_storage_items` (not paginated)
`get`, `list`, `listAll`, `create`, `update`, `delete`.

### 12.25 `RackStoragesResource` — path `rack_storages` (not paginated)
`get`, `list`, `listAll`, `create` (**'raw'**), `update`, `delete`.

### 12.26 `RelationsResource` — path `relations`
`list`, `listAll`, `create` (**'wrapped'**), `delete(id)`. (No single GET, no update.)

### 12.27 `S3ExportsResource` — path `s3_exports`
`create(data?): Promise<void>` — `POST /s3_exports` returns 200 (null body).

### 12.28 `UploadsResource` — path `uploads`
```ts
r.list(params?: ListParams): AsyncIterable<Upload>
r.listAll(params?): Promise<Upload[]>
r.upload(file: File | Blob | Buffer, data: { uploadable_id: number; uploadable_type: string }): Promise<Upload> // multipart; returns 'raw' Upload
r.get(id: number, opts?: { download?: boolean }): Promise<Upload | Blob>
r.delete(id: number): Promise<void>    // 204
```

### 12.29 `UsersResource` — path `users` (read-only)
`get(id): Promise<User>`, `list(params?): AsyncIterable<User>`, `listAll(params?): Promise<User[]>`.

### 12.30 `VlanZonesResource` — path `vlan_zones` (not paginated)
`get`, `list`, `listAll`, `create` (**'raw'**), `update` (PUT covers archive/unarchive via body), `delete`.

### 12.31 `VlansResource` — path `vlans` (not paginated)
`get`, `list`, `listAll`, `create` (**'raw'**), `update` (PUT covers archive/unarchive via body), `delete`.

### 12.32 `WebsitesResource` — path `websites`
`get`, `list`, `listAll`, `create` (**'raw'**), `update`, `delete`.
> **Gotcha**: `Websites.name` IS the URL and must include the protocol (`https://...`).

### 12.33 `ApiInfoResource` — path `api_info`
`get(): Promise<{ version: string; date: string }>`.

### 12.34 `ActivityLogsResource` — path `activity_logs`
```ts
r.list(params?: ActivityLogsListParams): AsyncIterable<ActivityLog>  // user_id?, user_email?, resource_id?, resource_type?, action_message?, start_date?
r.listAll(params?): Promise<ActivityLog[]>
r.deleteAll(params: { datetime: string; delete_unassigned_logs?: boolean }): Promise<void>  // DELETE /activity_logs — deletes ALL logs from a datetime (caller beware)
```

### 12.35 `CardsResource` — integrator cards
```ts
r.lookup(params: { integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<IntegratorCard[]>  // GET /cards/lookup
r.jump(params: { integration_type: string; integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<string>
```
- `lookup` unwraps `{ integrator_cards: [...] }` → `IntegratorCard[]`.
- `jump` is a browser-side redirect (no 200 in spec); follow the redirect and return the
  final URL, or throw the mapped error.

### Envelope/capability summary (authoritative; reviewer must re-verify against spec)

| Resource | singleKey | listKey | createType | paginated | delete? | notes |
|----------|-----------|---------|-----------|-----------|---------|-------|
| companies | company | companies | raw | yes | yes | + jump, archive/unarchive |
| articles | article | articles | raw | yes | yes | + archive/unarchive |
| asset_layouts | asset_layout | asset_layouts | wrapped | yes | no | |
| asset_passwords | asset_password | asset_passwords | wrapped | yes | yes | + archive/unarchive |
| assets (company) | asset | assets | raw | yes | yes | + archive/unarchive, move_layout; top-level `/assets` |
| expirations | – | – | – | yes | yes | no get/create |
| exports | – | – | void | no | no | + create(initiate), get(download) |
| flag_types | flag_type | flag_types | wrapped | yes | yes | |
| flags | flag | flags | wrapped | yes | yes | |
| folders | folder | folders | wrapped | yes | yes | |
| groups | – | – | – | yes | no | read-only |
| ip_addresses | – | – | raw | no | yes | |
| label_types | label_type | label_types | wrapped | yes | yes | |
| labels | label | labels | wrapped | yes | yes | |
| lists | – | – | raw | no | yes | |
| magic_dash | – | – | raw | yes | yes | deleteById, updatePositions |
| matchers | – | matchers | – | yes | yes | update/delete only; integration_id is query |
| networks | – | – | raw | no | yes | |
| password_folders | password_folder | password_folders | wrapped | yes | yes | |
| photos | photo | photos | wrapped | yes | yes | create is multipart |
| procedure_tasks | procedure_task | procedure_tasks | wrapped | no | yes | |
| procedures | procedure | procedures | raw | yes | yes | + duplicate/create_from_template/kickoff |
| public_photos | public_photo | public_photos | raw | yes | no | create/update multipart |
| rack_storage_items | – | – | – | no | yes | |
| rack_storages | – | – | raw | no | yes | |
| relations | relation | relations | wrapped | yes | yes | no get/update |
| s3_exports | – | – | void | no | no | initiate only |
| uploads | – | – | raw | yes | yes | multipart upload; get(download) |
| users | – | – | – | yes | no | read-only |
| vlan_zones | – | – | raw | no | yes | |
| vlans | – | – | raw | no | yes | |
| websites | – | – | raw | yes | yes | |
| api_info | – | – | – | no | no | get() only |
| activity_logs | – | – | – | yes | deleteAll | |
| cards | – | integrator_cards | – | no | no | lookup/jump |

`–` = not applicable / not documented in the spec; those single/list envelopes default to
pass-through (the raw body is returned as the typed value). Where a resource's list schema
is undocumented (`{}` in the spec, e.g. networks, groups, users, vlan, websites), the
resource still follows its documented key where the spec provides one, else passes through.

---

## 13. Types layer

- **One `types/<resource>.ts` per resource**, plus `types/common.ts` and a barrel.
- Interfaces mirror the Swagger `definitions` (PascalCase, no prefix). Fields keep exact
  snake_case names from the API (e.g. `company_id`, `asset_layout_id`, `created_at`).
- `id` is typed `number` (most definitions; where the spec says `integer` it is `number`).
- For each resource define, when the spec supports it:
  ```ts
  interface Company { id: number; slug: string; name: string; /* ... */ archived: boolean; created_at: string; /* ... */ }
  interface CompanyCreate { name: string; nickname?: string; /* ... */ }
  interface CompanyUpdate extends Partial<CompanyCreate> {}
  ```
- `types/common.ts`:
  ```ts
  export interface Page<T> { items: T[]; page: number; page_size: number; hasMore: boolean; }
  export interface ListParams { page?: number; page_size?: number; [key: string]: unknown; }
  export type EnvelopeKey = string;
  ```
- Nested shapes from definitions (`fields`, `cards`, `procedure_tasks_attributes`,
  `GroupMember`, `ListItem`, `Company_Integration`, `Asset_Layout_Field`) get their own
  interfaces inside the owning resource's type module.

> **No zod at runtime.** Types are compile-time only. MCP servers that want runtime
> validation add their own `zod` and derive schemas from these interfaces. Keeping `zod`
> out of the SDK's output keeps the bundle tiny and avoids a dependency mismatch with the
> consumer's MCP runtime.

---

## 14. Logger hook (`logger.ts`)

```ts
export interface Logger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}
export const NoopLogger: Logger = {};
```
- `HuduClient` and `HttpClient` accept an optional `Logger`. If not provided, `NoopLogger`.
- `HttpClient` logs at `debug` per request — the **method and the URL only** (no status, no duration;
  the transport logs before the fetch, so no status exists yet) — and at `warn` on retry/429.
  **Credential-shaped fields are masked** (no header value is ever logged; the URL is logged without
  query values that could carry sensitive data). Masking matches key NAMES — including
  `bearer`, `jwt`, `auth_header`, and any `…authorization` / `…apikey` spelling — and takes an
  optional extra-name list so a strategy's `secretHeaders` are masked in audit events too. It is not
  a value scrubber: a token embedded in free text is not detected, which is why the transport never
  interpolates a strategy's error text.

---

## 15. Dependency & build decisions

- **Runtime deps: three, confined to `src/content/`.** `turndown`, `@joplin/turndown-plugin-gfm`
  and `marked` power the Markdown converter (see §15.1). Everywhere else — native `fetch`,
  `AbortSignal.timeout`, `URLSearchParams`, `FormData`, `Blob` are all platform (Node ≥ 18).
- **`zod` is never a dependency.** It may appear only as a *dev* dependency of the
  consumer, never of the SDK.
- **Dev deps** (already scaffolded): `typescript`, `tsup`, `vitest` + `@vitest/coverage-v8`,
  `eslint` + `typescript-eslint`, `@types/node`, `rimraf`, `globals`, `@eslint/js`,
  `@esbuild/*`. Keep these; no new runtime dep is added.
- **TS config**: strict, `NodeNext` module resolution, `verbatimModuleSyntax`,
  `noUncheckedIndexedAccess` (use non-null assertions / narrowing where the spec guarantees
  presence), `declaration` on.
- **tsup**: dual ESM+CJS, `target: 'node24'`, `dts: true`. Add the subpath entries from §5
  if deep imports are adopted.

### 15.1 Why the zero-dependency property was retired (2026-09-17)

HTML↔Markdown conversion for article bodies broke it, deliberately. The property was
worth keeping while every subsystem could be written against native platform APIs.
Correct GFM table conversion and Markdown parsing are not in that category: turndown
does not convert tables without a plugin, and a hand-rolled converter would be a
standing correctness liability on the one path that can overwrite a customer's
documentation.

Three alternatives were weighed and rejected:

- **A separate `hudu-markdown` companion package** (the design's "approach C"), leaving
  this SDK zero-dep. Rejected: it splits the guard from the resource that needs it, and
  the loss check must run inside `articles.update` to be safe by default.
- **The unified/remark/rehype route.** Rejected: 5+ packages, every one ESM-only.
- **`@xberg-io/html-to-markdown`** — zero JS dependencies, byte-identical output to
  turndown on a tables/code/list fixture, 2000 conversions in 16ms, and structured
  `warnings`/`tables` output that would have suited the loss guard well. Rejected on
  maturity alone: created 2026-06-26, 27 versions to 3.14.0 in twelve weeks, ~4k weekly
  downloads against turndown's 6.65M, one maintainer, and 8 native `.node` binaries in
  an otherwise pure-JS SDK. On a watchlist for mid-2027; `src/content/turndown-engine.ts`
  exists as a one-file swap unit precisely for that.

The containment rule that makes this acceptable: the dependencies live behind
`src/content/`, no type of theirs appears in an exported signature, and every other
subsystem remains dependency-free.

---

## 16. Testing strategy

- **HTTP layer (`http.test.ts`)**: with a mocked global `fetch` — URL construction,
  credential headers (default `x-api-key` and a strategy), envelope pass-through, `204` → `undefined`,
  error mapping per status,
  retry/backoff on 429 with `Retry-After`, `AbortSignal` timeout, query sanitisation.
- **Pagination (`pagination.test.ts`)**: multi-page walk, early stop on short page,
  paginated vs non-paginated resources, `collectAll` equivalence.
- **Config/validation (`config.test.ts`)**: bad URLs, empty key, negative rate limit.
- **Auth (`auth.test.ts`)**: header shape per strategy, credential isolation between scopes, the
  fail-closed paths (`CONFIG_ERROR` / `AUTH_ERROR`), and redaction on log.
- **Per-resource (`resources/*.test.ts`)**: use `test/__fixtures__/` JSON captured from
  `api-docs.json` (wrapped list, wrapped single, raw create, wrapped create, empty success)
  to assert each method returns the **normalised** plain type.
- **Coverage gate** (vitest config): lines ≥ 97%, functions ≥ 94%, branches ≥ 83%, statements ≥ 97% (policy target 98% — gated a few points below measured). Measured on branch `feat/auth-strategy-23` (issue #23): lines 98.46%, statements 97.31%, functions 99.41%, branches 91.10% — all four gates pass.

---

## 17. Implementation order (for the implementer)

1. `logger.ts`, `errors.ts`, `auth.ts`, `utils.ts` (no deps).
2. `config.ts` (validation) + `config.test.ts`.
3. `http.ts` (`HttpClient`, envelope helpers, retries) + `http.test.ts` + `auth.test.ts`.
4. `pagination.ts` + `pagination.test.ts`.
5. `types/common.ts` + `types/*.ts` (all resource types from definitions).
6. `resources/base.ts`.
7. `resources/*.ts` — one at a time, starting with `companies.ts` as the canonical example.
8. `resources/index.ts`, `client.ts` (HuduClient wiring), `index.ts` barrel.
9. Package export-map / tsup subpath updates (if adopting deep imports).
10. Full `npm run typecheck && npm run lint && npm test` before any release.

---

## 18. Non-goals / explicit out-of-scope

- No OAuth FLOW and no cookie auth: the SDK produces request headers only and never exchanges a grant
  or a refresh token. A deployment that fronts Hudu with a bearer-accepting proxy is supported through
  `BearerTokenAuth`; Hudu's own document defines `APIKeyHeader` alone.
- No automatic retry of `POST` (except where the endpoint is explicitly idempotent and the
  method documents it as retry-safe).
- No binary/image decoding for MCP; `download`/`upload` methods return `Blob`/`File`
  metadata where the API supports it, mirroring the upstream behaviour.
- No zod generation or runtime schema validation inside the SDK.
- No auto-generated code from the spec at build time (types are hand-written from
  `api-docs.json` to stay stable and readable).

---

## Agent execution layer (0.3.0)

This SDK is also a deterministic execution layer for agents. The rules live in one place and the
machine-readable surface is generated, never hand-written:

| Artifact | Role |
|----------|------|
| `capabilities.plan.json` | **The authored source of record** — one row per operation (`endpoint`, `primitive`, `helper`, `effect`, `flags`, `dryRun`, `metadata`, `compact`, `resolution`, `staleCheck`, `redaction`, `errors`, `tests`, `group`, `status`). Judgement columns are human/Architect decisions; the rest is derived. |
| `src/capabilities.ts` | The **generated runtime registry** (`node-hudu/capabilities`), one record per implemented operation, zero imports. |
| `capabilities.json`, `capabilities.schema.json` | The emitted **data + JSON Schema** at the package root, for non-TypeScript consumers. Pin-checked by `planHash`. |
| `MCP_TOOL_MANIFEST.md` | The **mechanical MCP projection** of the registry; curation deltas are recorded in `MCP_TOOL_OVERRIDES.json`. |
| `src/mcp/catalog.generated.ts` | The **generated MCP tool catalog** (`node-hudu/mcp`, re-exported by `src/mcp/index.ts`): the CORE profile, the three META tool specs, the curated tool descriptions, the `hudu_search` contract, and one row per registry operation so a capability with no tool of its own is discoverable. Compiled like every other entry point, so a host that only has the tarball can import it. DATA and a schema reader only — validation and the write governor live once, in `src/operations/invoke.ts`. |
| `scripts/*.mjs` | `plan:derive`, `capabilities:build`, `capabilities:check` (the gate), `mcp:project`, `public-surface`. |

**The envelope/capability table above stays the contract for how responses are unwrapped** (singleKey,
listKey, createType, PUT-unwraps-by-singleKey, paginated, void deletes). Everything else about an
operation — its effect and flags, whether it can be dry-run, how it resolves, which errors it raises,
what its helpers return and what they drop — is in the capability matrix, because that is what both a
consumer and a tool generator need to read programmatically.

**Helper floor.** `resolve` on every record-bearing resource; `findBy<Field>` where the vendor filters and
callers look up by it; `search` where text search exists; `getContext` on the three workflow resources
(`companies`, `assets`, `articles`); plus the cross-resource helpers in `src/operations/`. Primitives stay
complete: adding a helper never shrinks the primitive surface, and no primitive returns a compact shape.

**The gate.** `npm run capabilities:check` fails on drift between the plan, the registry and the code, on a
missing helper, on an unanswered metadata column, on a mutation without a dry-run or a stale-check answer,
on a dangling `related` target, on an unproven helper scan cap, on a stale emitted JSON, and on a stale MCP
manifest. `--group A|B|C|D` scopes it to a batch; `--ship` requires every row to be `tested`. The checker
itself ships with a committed negative fixture (`test/fixtures/capabilities.plan.drifted.json`) that must
make it exit non-zero — a checker that has never failed is an untested checker.

**Additive-only proof.** `test/public-surface.test.ts` compares the live exported surface (root exports,
the types barrel, every resource method, every error code) against `test/__fixtures__/public-surface.json`,
which was captured from the 0.2.1 baseline ref. Removing any baseline name fails the suite; additions are
reported, not failed.
