# Design — Group B — infrastructure & config

Rows: **43 primitive rows + 14 helper rows** (all in `capabilities.plan.json` with `group: "B"`).
Resources: `networks`, `vlans`, `vlan_zones`, `ip_addresses`, `rack_storages`, `rack_storage_items`, `relations`, `flags`, `flag_types`.
Cross-cutting invariants: `SCOPING.md` decisions 1-14; the signature/overload pattern is in `.run/design/A.md` §1.

## Helpers

| Resource | helper | basis | compact | scan pages |
|---|---|---|---|---|
| networks | `resolve` | server-filter | NetworkSummary | 1 |
| networks | `findByAddress` | server-filter | NetworkSummary | 1 |
| vlans | `resolve` | server-filter | VlanSummary | 1 |
| vlans | `findByVlanId` | server-filter | VlanSummary | 1 |
| vlan_zones | `resolve` | server-filter | VlanZoneSummary | 1 |
| ip_addresses | `resolve` | server-filter | IpAddressSummary | 1 |
| ip_addresses | `findByAddress` | server-filter | IpAddressSummary | 1 |
| rack_storages | `resolve` | client-scan | RackStorageSummary | 1 |
| rack_storage_items | `resolve` | server-filter | RackStorageItemSummary | 1 |
| relations | `resolve` | client-scan | RelationSummary | 4 |
| relations | `findByEndpoints` | server-filter | RelationSummary | 4 |
| flags | `resolve` | server-filter | FlagSummary | 4 |
| flags | `findByFlagable` | server-filter | FlagSummary | 4 |
| flag_types | `resolve` | server-filter | FlagTypeSummary | 4 |

The `helperRationale`, `usage`, `preferredWhen`, `related`, `compact`, `resolution`, `errors` and
`tests` for every one of these rows are already authored in `capabilities.plan.json` — read the row, do not re-derive it.

## Compact shapes (declare in the resource's own type file `src/types/<resource>.ts`; primitives are unchanged)

| Shape | keeps | drops (must appear in the registry `outputSchema.drops`) |
|---|---|---|
| `NetworkSummary` | id, name, address, network_type, slug, company_id, location_id, vlan_id, status_list_item_id, role_list_item_id, url, updated_at | description, notes, ancestry, settings, sync_identifier, is_radar, created_at, archived_at |
| `VlanSummary` | id, name, slug, vlan_id, company_id, vlan_zone_id, status_list_item_id, role_list_item_id, networks_count, url, updated_at | description, notes, archived_at, created_at |
| `VlanZoneSummary` | id, name, slug, vlan_id_ranges, company_id, vlans_count, url, updated_at | description, archived_at, created_at |
| `IpAddressSummary` | address, status, fqdn, asset_id, network_id, company_id, description | notes, skip_dns_validation |
| `RackStorageSummary` | id, name, company_id, location_id, height, width, max_wattage, starting_unit, updated_at | description, created_at, discarded_at |
| `RackStorageItemSummary` | id, asset_id, asset_name, asset_url, rack_storage_role_id, rack_storage_role_name, start_unit, end_unit, side, status, company_id, url | max_wattage, power_draw, reserved_message, rack_storage_role_description, rack_storage_role_hex_color |
| `RelationSummary` | id, name, description, is_inverse, fromable_id, fromable_type, fromable_url, toable_id, toable_type, toable_url | created_at, updated_at |
| `FlagSummary` | id, flag_type_id, description, flagable_type, flagable_id, updated_at | created_at |
| `FlagTypeSummary` | id, name, slug, color | created_at, updated_at |

## Traps for this group

- **Every Group B list endpoint except `/flags`, `/flag_types` and `/relations` is NON-PAGINATED** (`/networks`, `/vlans`, `/vlan_zones`, `/ip_addresses`, `/rack_storages`, `/rack_storage_items`). `page`/`page_size` must never reach them; the helpers' `resolution.maxScanPages` is 1 for those and 4 for the paginated ones (already recorded per row in the plan).
- `ip_addresses`: the vendor's `IpAddress` definition declares no `id` field although `/ip_addresses/{id}` exists. Candidate labels must therefore fall back to the address. An ADDITIVE fix is allowed and encouraged: declare `id?: number` on `IpAddress` (optional, nothing removed) — say so in your report if you do it.
- `relations` and `activity_logs` have no `GET /{id}` endpoint: their `resolve` is an explicit bounded client scan (recorded as `basis: client-scan`).
- `rack_storage_items` and `flags` have no name field: `resolve` accepts ids only and must throw a structured validation error naming the accepted kinds for anything else (never guess, never scan unbounded).
- DELETE /magic_dash is form-urlencoded and takes a title+company_name (bulk by title) -> `POLICY_DENIED` unless the target is bounded explicitly.
- Never send `page`/`page_size` to a non-paginated endpoint from a helper either — assert it in a test.

## Gate

```
npx tsc --noEmit
npm run capabilities:build
npm run capabilities:check -- --group B    # rows must be implemented; helper methods must exist
npm test                                  # thresholds 97/94/83/97 unchanged
```
