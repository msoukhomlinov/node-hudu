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

/**
 * Compact projection of {@link Flag} (policy §9, helper tier).
 *
 * Keeps: id, flag_type_id, description, flagable_type, flagable_id, updated_at.
 * Drops (recorded in the capability registry `outputSchema.drops`): created_at.
 *
 * `id` is kept because a flag has no name and is resolved by id; `updated_at` is kept because
 * this resource declares `staleCheck: "updated_at"`.
 */
export interface FlagSummary {
  id: number;
  flag_type_id: number;
  description: string;
  flagable_type: string;
  flagable_id: number;
  updated_at: string;
}
