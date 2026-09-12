# Design — Group D — attachments, exports, rest

Rows: **34 primitive rows + 13 helper rows** (all in `capabilities.plan.json` with `group: "D"`).
Resources: `uploads`, `photos`, `public_photos`, `exports`, `s3_exports`, `lists`, `label_types`, `labels`, `users`.
Cross-cutting invariants: `SCOPING.md` decisions 1-14; the signature/overload pattern is in `.run/design/A.md` §1.

## Helpers

| Resource | helper | basis | compact | scan pages |
|---|---|---|---|---|
| uploads | `resolve` | server-filter | UploadSummary | 4 |
| photos | `resolve` | server-filter | PhotoSummary | 4 |
| photos | `findByPhotoable` | server-filter | PhotoSummary | 4 |
| public_photos | `resolve` | server-filter | _(full record)_ | 1 |
| exports | `resolve` | server-filter | ExportSummary | 1 |
| lists | `resolve` | server-filter | _(full record)_ | 4 |
| lists | `findByName` | server-filter | _(full record)_ | 4 |
| label_types | `resolve` | server-filter | LabelTypeSummary | 4 |
| labels | `resolve` | server-filter | LabelSummary | 4 |
| labels | `findByLabelable` | server-filter | LabelSummary | 4 |
| users | `resolve` | server-filter | UserSummary | 4 |
| users | `findByEmail` | server-filter | UserSummary | 4 |
| users | `search` | server-filter | UserSummary | 4 |

The `helperRationale`, `usage`, `preferredWhen`, `related`, `compact`, `resolution`, `errors` and
`tests` for every one of these rows are already authored in `capabilities.plan.json` — read the row, do not re-derive it.

## Compact shapes (declare in the resource's own type file `src/types/<resource>.ts`; primitives are unchanged)

| Shape | keeps | drops (must appear in the registry `outputSchema.drops`) |
|---|---|---|
| `UploadSummary` | id, name, ext, mime, size, url, uploadable_id, uploadable_type, created_date | archived_at |
| `PhotoSummary` | id, company_id, folder_id, photoable_type, photoable_id, caption, pinned, archived, updated_at | created_at |
| `ExportSummary` | id, account_id, status, is_pdf, file_name, file_size, created_at, updated_at, download_url | _(none — shape not used)_ |
| `LabelTypeSummary` | id, name, slug, color, applicable_record_types, access_level | allowed_company_ids, created_at, updated_at |
| `LabelSummary` | id, label_type_id, labelable_type, labelable_id, user_id, updated_at | created_at |
| `UserSummary` | id, email, first_name, last_name, slug, security_level, archived, portal_member_company_id, updated_at | otp_required_for_login, phone_number, time_zone, accepted_invite, sign_in_count, currently_signed_in, last_sign_in_at, last_sign_in_ip, created_at, score_30_days, score_all_time, score_90_days |

## Traps for this group

- `/lists` and `/exports` are NON-PAGINATED: `page`/`page_size` must never reach them. `/public_photos` is paginated but declares NO filters, so its `resolve` uses a single bounded fetch for the record-pair kind.
- **Multipart endpoints**: `photos.create`, `uploads.upload` and `public_photos.create/update` build FormData. A dry-run for these must validate the inputs WITHOUT building the multipart body twice, and must issue no POST/PUT.
- `exports.create` and `s3_exports.create` return **void** (empty 200): their dry-run has no server-computed result to promise, so the `DryRunResult.warnings` array must say exactly that. `s3_exports` has NO helper rows at all (write-only, no readable records — documented in SCOPING decision 14).
- `GET /exports/{id}?download=true`, `GET /photos/{id}?download=true`, `GET /uploads/{id}?download=true` and `GET /public_photos/{id}?download=true` return Blobs / 302 redirects. No helper may download: keep downloads on the primitives, and never add a binary tool to any manifest.
- `users` is read-only in this SDK (no create/update/delete in the spec): `resolve`/`findByEmail`/`search` only.
- No compact shape for `lists` (5 fields), `public_photos` (7 fields) or `exports` (the Export record is already compact): the plan records `compact: null` and the helpers return full records.
- `label_types.access_level` and `allowed_company_ids` are permission-bearing: keep `access_level` in the summary (agents need it) and make sure the audit/redaction tests cover label/label_type payloads.

## Gate

```
npx tsc --noEmit
npm run capabilities:build
npm run capabilities:check -- --group D    # rows must be implemented; helper methods must exist
npm test                                  # thresholds 97/94/83/97 unchanged
```
