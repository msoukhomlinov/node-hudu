/**
 * LabelType — Hudu API model
 */
export interface LabelType {
  id: number; // The unique ID of the label type.
  name: string; // The name of the label type.
  color: string; // The label type color as a hex value (e.g., #0000ff). Accepts 3- or 6-digit hex.
  slug: string; // The URL-friendly slug for the label type.
  applicable_record_types: ("Article" | "Asset" | "AssetPassword" | "Website" | "IpAddress" | "Vlan" | "VlanZone" | "Procedure" | "Network" | "RackStorage")[];
  access_level: "all_companies" | "specific_companies"; // Whether the label type is available to all companies or only specific companies.
  allowed_company_ids: number[]; // The company IDs the label type is restricted to. Only relevant when access_level is specific_companies; otherwise empty.
  created_at: string; // The date and time when the label type was created.
  updated_at: string; // The date and time when the label type was last updated.
}

/**
 * Input for creating a LabelType.
 * All fields are optional unless the API requires them; see docs.
 */
export type LabelTypeCreate = Partial<Omit<LabelType, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a LabelType.
 */
export type LabelTypeUpdate = Partial<LabelType>;
