/**
 * Label — Hudu API model
 */
export interface Label {
  id: number; // The unique ID of the label.
  label_type_id: number; // The ID of the label type this label belongs to.
  labelable_type: string; // The type of record this label is attached to (Article, Asset, AssetPassword, Website, IpAddress, Vlan, VlanZone, Procedure, Network, RackStorage).
  labelable_id: number; // The ID of the record this label is attached to.
  user_id: number; // The ID of the user who applied the label. Optional.
  created_at: string; // The date and time when the label was created.
  updated_at: string; // The date and time when the label was last updated.
}

/**
 * Input for creating a Label.
 * All fields are optional unless the API requires them; see docs.
 */
export type LabelCreate = Partial<Omit<Label, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Label.
 */
export type LabelUpdate = Partial<Label>;
