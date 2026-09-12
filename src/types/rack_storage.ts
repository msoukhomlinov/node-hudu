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
  created_at: string; // The date and time when the rack storage was created.
  updated_at: string; // The date and time when the rack storage was last updated.
  discarded_at: string | null; // The date and time when the rack storage was discarded. Can Be null.
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
  updated_at: string;
}
