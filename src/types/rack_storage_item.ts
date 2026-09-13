/**
 * RackStorageItem — Hudu API model
 */
export interface RackStorageItem {
  id: number; // The unique ID of the rack storage item.
  rack_storage_role_id: number; // The unique ID of the rack storage role.
  asset_id: number; // The unique ID of the asset.
  start_unit: number; // The start unit of the rack storage item.
  end_unit: number; // The end unit of the rack storage item.
  status: number; // The status of the rack storage item.
  side: number; // The side of the rack storage item.
  max_wattage: number; // The maximum wattage of the rack storage item.
  power_draw: number; // The power draw of the rack storage item.
  rack_storage_role_name: string; // The name of the rack storage role.
  reserved_message: string; // The reserved message for the rack storage item.
  rack_storage_role_description: string; // The description of the rack storage role.
  rack_storage_role_hex_color: string; // The hex color of the rack storage role.
  asset_name: string; // The name of the asset.
  asset_url: string; // The URL of the asset.
  url: string; // The URL of the rack storage item.
  company_id: number; // The unique ID of the company.
}

/**
 * Input for creating a RackStorageItem.
 * All fields are optional unless the API requires them; see docs.
 */
export type RackStorageItemCreate = Partial<Omit<RackStorageItem, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a RackStorageItem.
 */
export type RackStorageItemUpdate = Partial<RackStorageItem>;

/**
 * Compact projection of {@link RackStorageItem} (policy §9, helper tier).
 *
 * Keeps: id, asset_id, asset_name, asset_url, rack_storage_role_id, rack_storage_role_name,
 * start_unit, end_unit, side, status, company_id, url.
 * Drops (recorded in the capability registry `outputSchema.drops`): max_wattage, power_draw,
 * reserved_message, rack_storage_role_description, rack_storage_role_hex_color.
 *
 * `id` is kept because it is the only field a rack storage item can be resolved by: the vendor
 * exposes no name for a rack item.
 */
export interface RackStorageItemSummary {
  id: number;
  asset_id: number;
  asset_name: string;
  asset_url: string;
  rack_storage_role_id: number;
  rack_storage_role_name: string;
  start_unit: number;
  end_unit: number;
  side: number;
  status: number;
  company_id: number;
  url: string;
}
