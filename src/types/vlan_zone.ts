/**
 * VlanZone — Hudu API model
 */
export interface VlanZone {
  id: number; // The unique identifier for the VLAN Zone.
  name: string; // Human-readable zone name
  slug: string; // URL-friendly identifier
  description: string; // Optional description
  vlan_id_ranges: string; // Comma-separated list of numeric ranges (e.g. "100-500,1000-1500"). Each range must be inside 1-4094 and start <= end.
  company_id: number; // The identifier of the company that owns this VLAN Zone.
  archived_at: string; // The date and time when the VLAN Zone was archived. Null if not archived.
  created_at: string; // The date and time when the VLAN Zone was created.
  updated_at: string; // The date and time when the VLAN Zone was last updated.
  vlans_count: number; // Number of VLANs currently assigned to this zone
  url: string; // Link to zone in the web UI
}

/**
 * Input for creating a VlanZone.
 * All fields are optional unless the API requires them; see docs.
 */
export type VlanZoneCreate = Partial<Omit<VlanZone, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a VlanZone.
 */
export type VlanZoneUpdate = Partial<VlanZone>;
