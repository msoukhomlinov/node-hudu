# Design — Group C — operations & workflow

Rows: **29 primitive rows + 13 helper rows** (all in `capabilities.plan.json` with `group: "C"`).
Resources: `procedures`, `procedure_tasks`, `cards`, `activity_logs`, `expirations`, `matchers`, `magic_dash`, `api_info`.
Cross-cutting invariants: `SCOPING.md` decisions 1-14; the signature/overload pattern is in `.run/design/A.md` §1.

## Helpers

| Resource | helper | basis | compact | scan pages |
|---|---|---|---|---|
| procedures | `resolve` | server-filter | ProcedureSummary | 4 |
| procedures | `getWithTasks` | composite | ProcedureWithTasks | 4 |
| procedure_tasks | `resolve` | server-filter | ProcedureTaskSummary | 4 |
| cards | `resolve` | server-filter | IntegratorCardSummary | 4 |
| activity_logs | `resolve` | client-scan | ActivityLogSummary | 4 |
| activity_logs | `findByResource` | server-filter | ActivityLogSummary | 4 |
| expirations | `resolve` | server-filter | ExpirationSummary | 4 |
| expirations | `findByResource` | server-filter | ExpirationSummary | 4 |
| matchers | `resolve` | server-filter | _(full record)_ | 4 |
| matchers | `findBySyncId` | server-filter | _(full record)_ | 4 |
| magic_dash | `resolve` | client-scan | MagicDashSummary | 4 |
| magic_dash | `findByCompany` | server-filter | MagicDashSummary | 4 |
| api_info | `resolve` | server-filter | _(full record)_ | 4 |

The `helperRationale`, `usage`, `preferredWhen`, `related`, `compact`, `resolution`, `errors` and
`tests` for every one of these rows are already authored in `capabilities.plan.json` — read the row, do not re-derive it.

## Compact shapes (declare in the resource's own type file `src/types/<resource>.ts`; primitives are unchanged)

| Shape | keeps | drops (must appear in the registry `outputSchema.drops`) |
|---|---|---|
| `ProcedureSummary` | id, name, slug, company_id, company_name, status, total, completed, completion_percentage, process_type, url, updated_at | description, object_type, created_at, parent_procedure, run, parent_process_id, asset, share_url, procedure_tasks_attributes |
| `ProcedureTaskSummary` | id, name, position, priority, completed, completed_date, due_date, procedure_id, optional, parent_task_id, has_subtasks, subtask_count, first_assigned_user_name, url, updated_at | description, completion_notes, formatted_due_date, user_id, user_name, assigned_users, first_assigned_user_id, first_assigned_user_initials, subtask_ids, created_at |
| `IntegratorCardSummary` | id, integrator_id, integrator_name, link, primary_field, sync_type, sync_id, sync_identifier | data, office_365_assigned_products, exchange_license_assign_date, onedrive_license_assign_date, sharepoint_license_assign_date, skype_for_business_license_assign_date |
| `ActivityLogSummary` | id, user_id, user_email, resource_id, resource_type, action_message, created_at | updated_at |
| `ExpirationSummary` | id, date, expiration_type, company_id, expirationable_type, expirationable_id, asset_field_id, asset_layout_field_id, sync_id, updated_at | account_id, archived_at, created_at |
| `MagicDashSummary` | id, title, message, shade, icon, image_url, company_id, company_name, position | content_link, content |

## Traps for this group

- `/procedure_tasks` is NON-PAGINATED: `page`/`page_size` must never reach it.
- `cards` is not a CRUD resource: it has only `GET /cards/jump` and `GET /cards/lookup`. `cards.resolve` must use the lookup filters and, when the integration exposes a jump target, include the resolved URL — it must NOT invent get/create/update/delete methods.
- `activity_logs` has no `GET /{id}` (client-scan resolve) and its DELETE is a **bulk delete from a datetime on**, form/query based: it must refuse to run unconfirmed (`POLICY_DENIED`) and report `impact.scope: "bulk"` with the affected bound.
- `magic_dash`: no `GET /magic_dash/{id}` (client-scan resolve), `DELETE /magic_dash` is a bulk-by-title form-urlencoded delete (`POLICY_DENIED` unconfirmed), and `PUT /magic_dash/update_positions` is a multi-record field fan-out (`POLICY_DENIED` unconfirmed, `impact.scope: "bulk"`).
- `procedures.getWithTasks` is the group's one composite helper: it must instantiate `ProcedureTasksResource` from the SAME `HttpClient` (no client coupling), fetch the procedure, then its tasks with `procedure_id`, and bound the task list by `limit`. `procedures.kickoff` returns `{ message }` (not a Procedure) — do not change it.
- `api_info` is a singleton: `resolve` issues exactly ONE request and ignores the identifier (documented degenerate case).
- No compact shape for `matchers` (9 small fields) or `api_info` (2 fields): helpers return the full record and the plan records `compact: null` explicitly.

## Gate

```
npx tsc --noEmit
npm run capabilities:build
npm run capabilities:check -- --group C    # rows must be implemented; helper methods must exist
npm test                                  # thresholds 97/94/83/97 unchanged
```
