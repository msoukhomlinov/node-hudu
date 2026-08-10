/**
 * Flag — Hudu API model
 */
export interface Flag {
  id: number; // The unique ID of the flag.
  flag_type_id: number; // The ID of the flag type this flag belongs to.
  description: string; // An optional description for the flag.
  flagable_type: string; // The type of record this flag is attached to (Asset, Website, Article, AssetPassword, Company, Procedure, RackStorage, Network, IpAddress, Vlan, VlanZone).
  flagable_id: number; // The ID of the record this flag is attached to.
  created_at: string; // The date and time when the flag was created.
  updated_at: string; // The date and time when the flag was last updated.
}

/**
 * Input for creating a Flag.
 * All fields are optional unless the API requires them; see docs.
 */
export type FlagCreate = Partial<Omit<Flag, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Flag.
 */
export type FlagUpdate = Partial<Flag>;
