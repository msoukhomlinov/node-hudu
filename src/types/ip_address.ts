/**
 * IpAddress — Hudu API model
 */
export interface IpAddress {
  /**
   * The unique identifier for the IP address. ADDITIVE: `/ip_addresses/{id}` exists,
   * but the vendor's `IpAddress` definition declares no `id` field. Optional so that
   * nothing is removed and a record from the vendor's list endpoint still type-checks.
   */
  id?: number;
  address: string; // The IP address.
  status: string; // The status of the IP address. Must be one of: unassigned, assigned, reserved, deprecated, dhcp, or slaac
  fqdn: string; // The Fully Qualified Domain Name associated with the IP address.
  description: string; // A brief description of the IP address.
  notes: string; // Additional comments about the IP address.
  asset_id: number; // The identifier of the asset associated with this IP address.
  network_id: number; // The identifier of the network to which this IP address belongs.
  company_id: number; // The identifier of the company that owns this IP address.
  skip_dns_validation: boolean; // If true, the server will **not** attempt to verify that the FQDN resolves to the address when the record is created or updated. Use for internal-only hostnames.
}

/**
 * Input for creating a IpAddress.
 * All fields are optional unless the API requires them; see docs.
 */
export type IpAddressCreate = Partial<Omit<IpAddress, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a IpAddress.
 */
export type IpAddressUpdate = Partial<IpAddress>;

/**
 * Identifier accepted by `ip_addresses.resolve` (policy §6). Accepted kinds: id, exact
 * address, exact FQDN. Candidate labels fall back to the address because the vendor's
 * record definition does not declare an id.
 */
export interface IpAddressIdentifier {
  id?: number;
  address?: string;
  fqdn?: string;
}

/**
 * Compact projection returned by the `ip_addresses` helper tier (policy §9).
 * Drops: notes, skip_dns_validation. `id` is KEPT (optional, because the vendor's
 * record definition does not declare it): a compact shape must never drop the field a
 * caller resolves by, and an id the vendor did return is the address of the record.
 */
export interface IpAddressSummary {
  id?: number;
  address: string;
  status: string;
  fqdn: string;
  asset_id: number;
  network_id: number;
  company_id: number;
  description: string;
}
