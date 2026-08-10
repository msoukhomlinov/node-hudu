/**
 * IpAddress — Hudu API model
 */
export interface IpAddress {
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
