/**
 * Network — Hudu API model
 */
export interface Network {
  id: number; // The unique identifier for the network.
  name: string; // The name of the network.
  address: string; // The network address, typically in CIDR notation.
  network_type: number; // The type of network, represented as an integer.
  slug: string; // A slug representing the network.
  company_id: number; // The identifier of the company that owns this network.
  location_id: number; // The identifier of the location associated with this network.
  description: string; // A brief description of the network.
  notes: string; // Additional comments about the network.
  ancestry: string; // Ancestry path for hierarchical network structure.
  settings: Record<string, unknown>; // Settings for the network.
  sync_identifier: string; // External identifier for synchronization purposes.
  is_radar: boolean; // Indicates if the network was discovered automatically.
  status_list_item_id: number; // The status list item ID for this network.
  role_list_item_id: number; // The role list item ID for this network.
  vlan_id: number; // The VLAN ID associated with this network.
  created_at: string; // The date and time when the network was created.
  updated_at: string; // The date and time when the network was last updated.
  url: string; // The URL to access this network in the web interface.
  archived_at: string; // The date and time when the network was archived. Null if not archived.
}

/**
 * Input for creating a Network.
 * All fields are optional unless the API requires them; see docs.
 */
export type NetworkCreate = Partial<Omit<Network, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Network.
 */
export type NetworkUpdate = Partial<Network>;

/**
 * Identifier accepted by `networks.resolve` (policy §6). Accepted kinds: id, slug,
 * exact name, address (CIDR). A kind the vendor cannot filter on is rejected with a
 * structured validation error instead of guessing.
 */
export interface NetworkIdentifier {
  id?: number;
  slug?: string;
  name?: string;
  address?: string;
}

/**
 * Compact projection returned by the `networks` helper tier (policy §9).
 * Drops: description, notes, ancestry, settings, sync_identifier, is_radar,
 * created_at, archived_at. Primitives keep returning the full `Network`.
 */
export interface NetworkSummary {
  id: number;
  name: string;
  address: string;
  network_type: number;
  slug: string;
  company_id: number;
  location_id: number;
  vlan_id: number;
  status_list_item_id: number;
  role_list_item_id: number;
  url: string;
  updated_at: string;
}
