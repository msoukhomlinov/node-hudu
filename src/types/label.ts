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

/**
 * Object form of a `LabelsResource.resolve` identifier (agent-execution-layer §6).
 * A label has no `name`, so the accepted kinds are numeric `id` and the
 * `{ labelableType, labelableId }` pair of the record it is attached to.
 */
export interface LabelIdentifier {
  id?: number;
  labelableType?: string;
  labelableId?: number;
}

/**
 * Compact projection of a Label (policy §9). Drops `created_at`; keeps every field
 * an agent uses to answer "what is this record tagged with", including `id`.
 */
export interface LabelSummary {
  id: number;
  label_type_id: number;
  labelable_type: string;
  labelable_id: number;
  user_id: number;
  updated_at: string;
}
