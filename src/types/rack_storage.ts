/**
 * RackStorage — Hudu API model
 */
export interface RackStorage {
  id: number; // The unique ID of the rack storage.
  location_id: number; // The unique ID of the location of the rack storage.
  name: string; // The name of the rack storage.
  description: string; // The description of the rack storage.
  max_wattage: number; // The maximum wattage the rack storage can handle.
  starting_unit: number; // The starting unit of the rack storage.
  height: number; // The height of the rack storage.
  width: number; // The width of the rack storage.
  // Live-verified on Hudu 2.45.1 (2026-09-12): GET /rack_storages and the create/update
  // responses send NEITHER timestamp (observed keys: id, name, description,
  // descending_units, starting_unit, height, max_wattage, width, serial_number, asset_tag,
  // front_items, rear_items, location_name, location_url, location_id, utilization,
  // power_draw_utilization, power_utilization, company_id). api-docs.json declares them,
  // the vendor does not send them, so they are optional: no stale guard can be honoured on
  // this resource, and the registry says `staleCheck: "unavailable"`.
  created_at?: string; // Declared by api-docs.json; never observed in a live response.
  updated_at?: string; // Declared by api-docs.json; never observed in a live response.
  discarded_at?: string | null; // Not observed in a live response either.
  company_id: number; // The unique ID of the company.
}

/**
 * Input for creating a RackStorage.
 * All fields are optional unless the API requires them; see docs.
 */
export type RackStorageCreate = Partial<Omit<RackStorage, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a RackStorage.
 */
export type RackStorageUpdate = Partial<RackStorage>;

/**
 * Identifier accepted by `rack_storages.resolve` (policy §6). Accepted kinds: id and
 * exact name. Hudu declares no name filter on `/rack_storages`, so the name kind is a
 * bounded client scan (one complete read of the non-paginated collection).
 */
export interface RackStorageIdentifier {
  id?: number;
  name?: string;
}

/**
 * Compact projection returned by the `rack_storages` helper tier (policy §9).
 * Drops: description, created_at, discarded_at.
 */
export interface RackStorageSummary {
  id: number;
  name: string;
  company_id: number;
  location_id: number;
  height: number;
  width: number;
  max_wattage: number;
  starting_unit: number;
  /** Absent in every live response (see `RackStorage.updated_at`). */
  updated_at?: string;
}
