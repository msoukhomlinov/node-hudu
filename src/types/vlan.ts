/**
 * Vlan — Hudu API model
 */
export interface Vlan {
  id: number; // The unique identifier for the VLAN.
  name: string; // Human-readable VLAN name
  slug: string; // URL-friendly identifier
  vlan_id: number; // Numeric VLAN (1-4094)
  description: string; // Optional description
  notes: string; // Rich-text notes
  company_id: number; // The identifier of the company that owns this VLAN.
  vlan_zone_id: number; // Zone (nullable)
  status_list_item_id: number; // The status list item ID for this VLAN.
  role_list_item_id: number; // The role list item ID for this VLAN.
  archived_at: string; // The date and time when the VLAN was archived. Null if not archived.
  created_at: string; // The date and time when the VLAN was created.
  updated_at: string; // The date and time when the VLAN was last updated.
  networks_count: number; // Number of networks currently assigned to this VLAN.
  url: string; // Link to VLAN in the web UI
}

/**
 * Input for creating a Vlan.
 * All fields are optional unless the API requires them; see docs.
 */
export type VlanCreate = Partial<Omit<Vlan, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Vlan.
 */
export type VlanUpdate = Partial<Vlan>;

/**
 * Identifier accepted by `vlans.resolve` (policy §6). Accepted kinds: id, vlan_id,
 * exact name. The vendor declares no slug filter, so `{ slug }` is rejected with a
 * structured validation error rather than guessed.
 */
export interface VlanIdentifier {
  id?: number;
  vlan_id?: number;
  name?: string;
}

/**
 * Compact projection returned by the `vlans` helper tier (policy §9).
 * Drops: description, notes, archived_at, created_at.
 */
export interface VlanSummary {
  id: number;
  name: string;
  slug: string;
  vlan_id: number;
  company_id: number;
  vlan_zone_id: number;
  status_list_item_id: number;
  role_list_item_id: number;
  networks_count: number;
  url: string;
  updated_at: string;
}
