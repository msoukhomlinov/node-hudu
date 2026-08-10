/**
 * Asset_Layout_Field — Hudu API model
 */
export interface AssetLayoutField {
  id: number;
  label: string;
  show_in_list: boolean;
  field_type: string;
  required: boolean; // Can be null.
  hint: string;
  min: number; // Can be null.
  max: number; // Can be null.
  linkable_id: number;
  expiration: boolean;
  options: string;
  position: number;
  is_destroyed: boolean;
  list_id: number; // ID of the List to pull values from. Required for ListSelect field type. Can be updated to change the associated list. WARNING: Changing this value will clear all existing asset field values for this field.
  multiple_options: boolean; // Whether to allow multiple options for ListSelect fields
}

/**
 * Input for creating a Asset_Layout_Field.
 * All fields are optional unless the API requires them; see docs.
 */
export type AssetLayoutFieldCreate = Partial<Omit<AssetLayoutField, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Asset_Layout_Field.
 */
export type AssetLayoutFieldUpdate = Partial<AssetLayoutField>;
