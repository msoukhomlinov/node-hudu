# Design — Group A (primary nouns) · node-hudu agent-execution-layer retrofit

Rows: **52 primitive rows + 25 helper rows** (all in `capabilities.plan.json` with `group: "A"`).
Resources: `companies`, `articles`, `assets`, `asset_layouts`, `asset_passwords`, `websites`, `folders`, `password_folders`, `groups`.
Cross-cutting invariants: `SCOPING.md` decisions 1–14. Policy: `agent-execution-layer.md` §5–§11.

## 1. Helper floor for Group A (25 helpers)

| Resource | helper | basis | compact | notes |
|----------|--------|-------|---------|-------|
| companies | `resolve` | server-filter | CompanySummary | kinds: id, slug, name, website/domain |
| companies | `findByDomain` | server-filter | CompanySummary | vendor `website` filter + exact compare |
| companies | `findBySlug` | server-filter | CompanySummary | vendor `slug` filter |
| companies | `search` | server-filter | CompanySummary | vendor `search`, limit 25 / max 100 |
| companies | `getContext` | workflow | CompanyContext | bounded assets/articles/websites/assetPasswords |
| articles | `resolve` | server-filter | ArticleSummary | kinds: id, slug, name (+company_id) |
| articles | `findBySlug` | server-filter | ArticleSummary | |
| articles | `search` | server-filter | ArticleSummary | optional company_id |
| articles | `getContext` | workflow | ArticleContext | article + company + folder |
| assets | `resolve` | server-filter | AssetSummary | {companyId,id} direct; serial/name/slug account-wide |
| assets | `findBySerial` | server-filter | AssetSummary | vendor `primary_serial` |
| assets | `search` | server-filter | AssetSummary | optional company_id |
| assets | `getContext` | workflow | AssetContext | asset + layout + expirations + relations |
| asset_layouts | `resolve` | server-filter | AssetLayoutSummary | kinds: id, slug, name |
| asset_passwords | `resolve` | server-filter | AssetPasswordSummary | NOT_FOUND on id miss; summary omits the secret |
| asset_passwords | `findBySlug` | server-filter | AssetPasswordSummary | |
| asset_passwords | `search` | server-filter | AssetPasswordSummary | summary never carries password/otp_secret |
| websites | `resolve` | server-filter | WebsiteSummary | kinds: id, slug, name |
| websites | `findBySlug` | server-filter | WebsiteSummary | |
| websites | `search` | server-filter | WebsiteSummary | |
| folders | `resolve` | server-filter | FolderSummary | name filter; optional companyId/folderType |
| password_folders | `resolve` | server-filter | PasswordFolderSummary | name filter; optional companyId |
| password_folders | `search` | server-filter | PasswordFolderSummary | |
| groups | `resolve` | server-filter | GroupSummary | kinds: id, slug, name |
| groups | `search` | server-filter | GroupSummary | |

No helper beyond the floor in Group A (`helperCap: 4` unused).

### Required signature pattern (overloads keep every existing call untouched)

```typescript
export interface CompanyIdentifier { id?: number; name?: string; slug?: string; website?: string; domain?: string }

// default → compact; expand: true → full record; resolutionDetails: true → Resolution<T>
async resolve(identifier: number | string | CompanyIdentifier): Promise<CompanySummary | null>;
async resolve(identifier: number | string | CompanyIdentifier, opts: { expand: true }): Promise<Company | null>;
async resolve(identifier: number | string | CompanyIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<CompanySummary>>;
async resolve(
  identifier: number | string | CompanyIdentifier,
  opts?: { expand?: boolean; resolutionDetails?: boolean },
): Promise<Company | CompanySummary | null | Resolution<CompanySummary>>;

async findByDomain(domain: string, opts?: { expand?: true }): Promise<CompanySummary | Company | null>;
async search(query: string, opts?: { limit?: number; expand?: boolean }): Promise<CompanySummary[] | Company[]>;
async getContext(id: number, opts?: { limit?: number; expand?: boolean }): Promise<CompanyContext>;
```

- `limit` default **25**, hard maximum **100** (throw `HuduConfigError` above the max — deterministic, not silently clamped).
- Bare-value kind order is documented per resource in the registry `usage`; Group A order is **numeric id → slug → exact name → domain**.
- `{ id }` miss throws `NOT_FOUND` (never `null`). `null` means "a complete scan found nothing".
- At the scan cap: throw `RESOLUTION_TRUNCATED`. Several inexact matches: throw `RESOLUTION_AMBIGUOUS` with candidate ids in `resourceIds`.
- Every helper that pages uses `BaseResource.boundedScan` (500 records / 4 pages by default, from client config).

## 2. Compact shapes (declare in the resource's own type file `src/types/<resource>.ts`; primitives are unchanged)

| Shape | keeps | drops (must be recorded in the registry `outputSchema.drops`) |
|-------|-------|-------------------------------------------------------------|
| `CompanySummary` | id, name, nickname, slug, website, phone_number, city, state, id_number, archived, url, updated_at | notes, address_line_1/2, zip, country_name, company_type, parent_company_id, parent_company_name, fax_number, object_type, full_url, passwords_url, knowledge_base_url, integrations, created_at |
| `ArticleSummary` | id, name, slug, company_id, folder_id, draft, enable_sharing, updated_at | content, url, share_url, public_photos, object_type, created_at |
| `AssetSummary` | id, name, company_id, company_name, asset_layout_id, primary_serial, asset_type, archived, url, updated_at | fields, cards, value, label, position, primary_mail, primary_model, primary_manufacturer, slug, object_type, created_at |
| `AssetLayoutSummary` | id, name, slug, active, icon, color | fields, include_passwords, include_photos, include_comments, include_files, sidebar_folder_id, icon_color, created_at, updated_at |
| `AssetPasswordSummary` | id, name, slug, company_id, password_folder_id, password_folder_name, username, url, login_url, password_type, updated_at | **password, otp_secret**, description, passwordable_id, passwordable_type, created_at |
| `WebsiteSummary` | id, name, slug, company_id, company_name, status, monitoring_status, paused, archived, url, updated_at | headers, account_id, asset_field_id, discarded_at, disable_ssl, disable_whois, disable_dns, enable_dmarc_tracking, enable_dkim_tracking, enable_spf_tracking, keyword, message, monitor_type, code, sent_notifications, icon, asset_type, refreshed_at, monitored_at, notes, object_type |
| `FolderSummary` | id, name, company_id, parent_folder_id, folder_type, icon, updated_at | description, created_at |
| `PasswordFolderSummary` | id, name, company_id, slug, security, updated_at | allowed_groups, description, created_at |
| `GroupSummary` | id, name, slug, default, member_count, updated_at | members, url, created_at |

Composite contexts (declare next to their resource type): `CompanyContext { company; assets; articles; websites; assetPasswords }`,
`ArticleContext { article; company; folder }`,
`AssetContext { asset; layout; expirations; relations }` — every sub-list bounded by `limit`.

## 3. Classification / safety (already recorded per row in the plan)

- `asset_passwords` and `password_folders`: every row `sensitive`; their deletes add `requiresApproval`; `redaction: "credentials"`.
- PUT/DELETE rows are `idempotent`; DELETE rows are `destructive` + `requiresApproval`.
- `staleCheck: "updated_at"` on 20 mutation rows (the resources whose record type has `updated_at` and whose update goes through `updateOne`); `assets` mutations are `"unavailable"` because its update is hand-rolled — the implementer must either route `assets.update` through `updateOne` (preferred, then the guard applies) or keep `unavailable` and say so.
- Every mutation row accepts `{ dryRun: true }` and must return `DryRunResult` with `simulated: true` and **no mutating request**.

## 4. Cross-resource reads inside `getContext`

`getContext` is a resource method, but it needs sibling resources. Instantiate them from the SAME
`HttpClient` inside the resource class (`new ArticlesResource(this.http)`) — no client-level coupling,
no import cycle (verified: `articles`/`assets`/`websites`/`expirations`/`relations`/`asset_layouts`
do not import `companies`). Each sub-fetch passes `limit` and never uses `listAll`.

## 5. Traps for this group

- Non-paginated: `/lists`, `/networks`, `/vlan_zones`, `/vlans`, `/ip_addresses`, `/rack_storages`,
  `/rack_storage_items`, `/procedure_tasks`, `/exports` never take `page`/`page_size`. None are in Group A.
- Company-scoped assets: `assets.get/create/update/delete/archive/unarchive/moveLayout` take `(companyId, id)`.
  `assets.resolve({ id })` needs `companyId`; a bare id is resolved account-wide via `GET /assets?id=`.
- PUT always unwraps by `singleKey` — reuse `updateOne`, never hand-roll a PUT.
- `photos`/`public_photos` multipart is Group D; do not touch.
- `asset_passwords` returns secrets: the summary must drop them, the audit payload must redact them,
  and the returned full record must NOT be silently redacted.

## 6. Gate

```
npx tsc --noEmit
npm run capabilities:build
npm run capabilities:check -- --group A     # rows must be implemented; helper methods must exist
npm test                                    # thresholds 97/94/83/97 unchanged
```
