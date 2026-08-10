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
